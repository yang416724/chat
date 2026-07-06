/* ============================================================
 * deepgram-voice.js
 * Deepgram 实时语音输入模块
 *
 * 功能流程：
 *   1. 点击麦克风按钮 → 浏览器采集麦克风音频 (MediaRecorder, Opus)
 *   2. 音频块通过 WebSocket 实时发送到 Deepgram 实时识别接口
 *   3. 识别返回的 interim 结果实时填入输入框（边说边出字）
 *   4. is_final=true 的终局结果累加，当 VAD 判断用户说完
 *      (WebSocket 因 vad_turnoff 关闭) 时自动触发发送
 *   5. 发送后麦克风保持开启，自动重连 WebSocket 以实现连续对话
 *   6. 再次点击麦克风按钮 → 停止录音并关闭连接
 *
 * 注意：浏览器 WebSocket API 不支持自定义请求头，
 *      因此无法使用 "Authorization: Token <key>" 请求头，
 *      改用 URL 查询参数 token 传递 Deepgram API Key。
 * ============================================================ */

(function () {
  "use strict";

  // === 模块内部状态 ===
  const voiceState = {
    isRecording: false, // 是否正在录音
    userStopped: false, // 用户是否主动停止（用于区分 VAD 自动断开）
    mediaStream: null, // 麦克风媒体流
    mediaRecorder: null, // MediaRecorder 实例（持续运行）
    webSocket: null, // 当前 Deepgram WebSocket 连接
    finalText: "", // 已确认的终局文字（累加）
    interimText: "", // 当前临时识别文字
    reconnectTimer: null, // 重连计时器
    reconnectAttempts: 0, // 连续重连失败计数
    connectionOpenTime: 0, // 本次连接建立时间戳
  };

  // === 配置读取 ===
  function getConfig() {
    const cfg = (window.state && window.state.apiConfig) || {};
    return {
      apiKey: cfg.deepgramApiKey || "",
      language: cfg.deepgramLanguage || "zh",
    };
  }

  // === 构造 Deepgram WebSocket URL ===
  function buildWebSocketUrl(apiKey, language) {
    const params = new URLSearchParams({
      encoding: "opus",
      sample_rate: "16000",
      interim_results: "true",
      vad_turnoff: "true",
      punctuate: "true",
      smart_format: "true",
      model: "nova-2",
      language: language,
      // 浏览器 WebSocket 无法设置 Authorization 请求头，用 token 查询参数替代
      token: apiKey,
    });
    return "wss://api.deepgram.com/v1/listen?" + params.toString();
  }

  // === 获取浏览器支持的音频 MIME 类型 ===
  function getSupportedMimeType() {
    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];
    for (const t of types) {
      if (
        window.MediaRecorder &&
        typeof MediaRecorder.isTypeSupported === "function" &&
        MediaRecorder.isTypeSupported(t)
      ) {
        return t;
      }
    }
    return "";
  }

  // === 更新输入框显示 ===
  function updateInputDisplay() {
    const chatInput = document.getElementById("chat-input");
    if (!chatInput) return;
    chatInput.value = voiceState.finalText + voiceState.interimText;
    // 触发 input 事件以便其他监听器（如自动高度调整）响应
    chatInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // === 触发发送按钮点击 ===
  function triggerSend() {
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn) sendBtn.click();
  }

  // === 解析 Deepgram 返回的 JSON 消息 ===
  function parseDeepgramMessage(jsonStr) {
    let msg;
    try {
      msg = JSON.parse(jsonStr);
    } catch (e) {
      return;
    }

    // Deepgram 返回结构: { type, channel: { alternatives: [{ transcript }] }, is_final }
    const alt =
      msg.channel &&
      msg.channel.alternatives &&
      msg.channel.alternatives[0];
    const transcript = alt ? alt.transcript : "";
    if (!transcript) return;

    if (msg.is_final) {
      // 终局结果：累加到已确认文字，清空临时文字
      voiceState.finalText = (voiceState.finalText + transcript).trim();
      voiceState.interimText = "";
      updateInputDisplay();
    } else {
      // 临时结果：实时显示（覆盖上一帧临时文字）
      voiceState.interimText = transcript;
      updateInputDisplay();
    }
  }

  // === 建立 / 重连 Deepgram WebSocket ===
  function setupWebSocket() {
    const { apiKey, language } = getConfig();
    if (!apiKey) {
      alert("请先在设置中填写 Deepgram API Key。");
      stopVoiceInput();
      return;
    }

    let ws;
    try {
      ws = new WebSocket(buildWebSocketUrl(apiKey, language));
    } catch (err) {
      console.error("[Deepgram] WebSocket 创建失败:", err);
      alert("无法连接 Deepgram，请检查网络或 API Key。");
      stopVoiceInput();
      return;
    }

    voiceState.webSocket = ws;
    voiceState.connectionOpenTime = 0;

    ws.onopen = () => {
      console.log("[Deepgram] WebSocket 已连接");
      voiceState.connectionOpenTime = Date.now();
      voiceState.reconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
      // Deepgram 返回 JSON 文本
      if (typeof event.data === "string") {
        parseDeepgramMessage(event.data);
      } else if (event.data instanceof Blob) {
        event.data.text().then((text) => parseDeepgramMessage(text));
      }
      // ArrayBuffer 类型不做处理（Deepgram 不会发送二进制）
    };

    ws.onerror = (err) => {
      console.error("[Deepgram] WebSocket 错误:", err);
    };

    ws.onclose = (event) => {
      console.log(
        "[Deepgram] WebSocket 关闭: code=" + event.code + " reason=" + event.reason,
      );

      // 清除当前 WebSocket 引用，MediaRecorder 不再向已关闭的连接发送数据
      if (voiceState.webSocket === ws) {
        voiceState.webSocket = null;
      }

      // 如果连接建立后立刻关闭（< 1.5 秒），通常是 API Key 无效或额度不足
      if (
        voiceState.connectionOpenTime > 0 &&
        Date.now() - voiceState.connectionOpenTime < 1500
      ) {
        voiceState.reconnectAttempts++;
        if (voiceState.reconnectAttempts >= 2) {
          alert(
            "Deepgram 连接立即关闭，可能是 API Key 无效或账户额度不足。\n(code: " +
              event.code +
              ")",
          );
          stopVoiceInput();
          return;
        }
      }

      // VAD 检测到静音 → 用户说完了当前这句话
      // 发送已识别的终局文字
      if (voiceState.finalText.trim()) {
        triggerSend();
        voiceState.finalText = "";
        voiceState.interimText = "";
      }

      // 如果用户未主动停止，重连 WebSocket 以保持连续对话
      if (!voiceState.userStopped && voiceState.isRecording) {
        if (voiceState.reconnectTimer) clearTimeout(voiceState.reconnectTimer);
        voiceState.reconnectTimer = setTimeout(() => {
          voiceState.reconnectTimer = null;
          if (!voiceState.userStopped && voiceState.isRecording) {
            setupWebSocket();
          }
        }, 400);
      }
    };
  }

  // === 启动语音输入 ===
  async function startVoiceInput() {
    // 检查浏览器支持
    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia ||
      !window.MediaRecorder
    ) {
      alert("当前浏览器不支持麦克风录音 (MediaRecorder / getUserMedia)。");
      return;
    }

    const { apiKey } = getConfig();
    if (!apiKey) {
      alert("请先在设置中填写 Deepgram API Key。");
      return;
    }

    if (voiceState.isRecording) return;

    // 请求麦克风权限
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      console.error("[Deepgram] 麦克风访问失败:", err);
      let hint = err.message || err.name || "未知错误";
      if (err.name === "NotAllowedError") {
        hint = "麦克风权限被拒绝，请在浏览器设置中允许访问麦克风。";
      } else if (err.name === "NotFoundError") {
        hint = "未检测到麦克风设备。";
      }
      alert("无法访问麦克风：" + hint);
      return;
    }

    voiceState.mediaStream = stream;
    voiceState.finalText = "";
    voiceState.interimText = "";
    voiceState.userStopped = false;
    voiceState.reconnectAttempts = 0;

    // 先建立 WebSocket
    setupWebSocket();

    // 启动 MediaRecorder（持续运行，通过 ondataavailable 向 WebSocket 发送音频块）
    try {
      const mimeType = getSupportedMimeType();
      const options = mimeType ? { mimeType: mimeType } : {};
      const mr = new MediaRecorder(stream, options);
      voiceState.mediaRecorder = mr;

      mr.ondataavailable = (e) => {
        if (
          e.data &&
          e.data.size > 0 &&
          voiceState.webSocket &&
          voiceState.webSocket.readyState === WebSocket.OPEN
        ) {
          voiceState.webSocket.send(e.data);
        }
      };

      mr.onerror = (err) => {
        console.error("[Deepgram] MediaRecorder 错误:", err);
      };

      // 每 250ms 产生一个音频块，实现边录边传
      mr.start(250);
    } catch (err) {
      console.error("[Deepgram] MediaRecorder 启动失败:", err);
      alert("录音启动失败：" + (err.message || err.name));
      stopVoiceInput();
      return;
    }

    voiceState.isRecording = true;
    const btn = document.getElementById("voice-input-btn");
    if (btn) btn.classList.add("recording");
    console.log("[Deepgram] 语音输入已启动");
  }

  // === 停止语音输入 ===
  function stopVoiceInput() {
    voiceState.userStopped = true;
    voiceState.isRecording = false;

    // 清除重连计时器
    if (voiceState.reconnectTimer) {
      clearTimeout(voiceState.reconnectTimer);
      voiceState.reconnectTimer = null;
    }

    // 如果还有未发送的文字，发送出去
    if (voiceState.finalText.trim()) {
      triggerSend();
    }
    voiceState.finalText = "";
    voiceState.interimText = "";

    // 停止 MediaRecorder
    if (
      voiceState.mediaRecorder &&
      voiceState.mediaRecorder.state !== "inactive"
    ) {
      try {
        voiceState.mediaRecorder.stop();
      } catch (e) {
        /* ignore */
      }
    }
    voiceState.mediaRecorder = null;

    // 关闭 WebSocket
    if (voiceState.webSocket) {
      try {
        voiceState.webSocket.onclose = null; // 防止触发重连逻辑
        voiceState.webSocket.close();
      } catch (e) {
        /* ignore */
      }
      voiceState.webSocket = null;
    }

    // 停止麦克风轨道
    if (voiceState.mediaStream) {
      voiceState.mediaStream.getTracks().forEach((t) => t.stop());
      voiceState.mediaStream = null;
    }

    // 移除录音状态样式
    const btn = document.getElementById("voice-input-btn");
    if (btn) btn.classList.remove("recording");
    console.log("[Deepgram] 语音输入已停止");
  }

  // === 切换录音状态 ===
  function toggleVoiceInput() {
    if (voiceState.isRecording) {
      stopVoiceInput();
    } else {
      startVoiceInput();
    }
  }

  // === 初始化：绑定麦克风按钮事件 ===
  function initVoiceInputButton() {
    const btn = document.getElementById("voice-input-btn");
    if (btn && !btn._deepgramBound) {
      btn.addEventListener("click", toggleVoiceInput);
      btn._deepgramBound = true; // 防止重复绑定
      console.log("[Deepgram] 麦克风按钮已绑定");
    }
  }

  // === DOM 就绪后初始化 ===
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initVoiceInputButton);
  } else {
    initVoiceInputButton();
  }

  // 暴露调试接口（可选）
  window.deepgramVoice = {
    start: startVoiceInput,
    stop: stopVoiceInput,
    toggle: toggleVoiceInput,
    state: voiceState,
  };
})();
