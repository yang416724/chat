/* --- 娃娃机逻辑开始 --- */

// 1. 默认娃娃图片列表 (在这里替换你想给用户的默认图片URL)
const DEFAULT_DOLL_IMAGES = [
  "https://i.postimg.cc/3rCsgRTN/tkwwj2.png",
  "https://i.postimg.cc/yxB2MqFB/tkwwj.png",
  "https://i.postimg.cc/3xnr91QF/tkwwj12.png",
  "https://i.postimg.cc/8ztkw4gH/tkwwj11.png",
  "https://i.postimg.cc/dV4Qn6c9/tkwwj10.png",
  "https://i.postimg.cc/9MvHk9DZ/wwj6.png",
];

// 2. 奖励等级配置
const REWARD_TIERS = [
  { type: "coin_small", value: 10, label: "零钱", prob: 40, color: "#edd1d1" },
  { type: "coin_mid", value: 50, label: "红包", prob: 30, color: "#d4a5a5" },
  { type: "coin_big", value: 100, label: "巨款", prob: 15, color: "#b58e8e" },
  { type: "bad_luck", value: -20, label: "扣除", prob: 10, color: "#9e9e9e" },
  { type: "mystery", value: 0, label: "神秘", prob: 5, color: "#c9c0bb" },
];

let clawState = {
  x: 50,
  y: 0,
  isGrabbing: false,
  joystickInterval: null,
};

async function initClawMachineData() {
  const count = await db.clawMachineDolls.count();
  if (count === 0) {
    console.log("初始化默认娃娃图片...");
    const dollObjects = DEFAULT_DOLL_IMAGES.map((url) => ({ url: url }));
    await db.clawMachineDolls.bulkAdd(dollObjects);
  }
}

async function openClawMachine() {
  await initClawMachineData();
  const modal = document.getElementById("claw-machine-modal");
  modal.classList.add("visible");
  updateClawBalanceDisplay();
  await resetClawMachine(); // 重置并生成新娃娃
  initJoystick();
}

function updateClawBalanceDisplay() {
  document.getElementById("claw-machine-balance").textContent = (
    state.globalSettings.userBalance || 0
  ).toFixed(2);
}

// ★★★ 核心修改：渲染实时统计饼图 ★★★
// 这个函数现在不读配置表，而是读取 #doll-pool 里的实际元素
function renderRealTimeStats() {
  const pieChart = document.getElementById("prob-pie-chart");
  const legendEl = document.getElementById("prob-legend");
  legendEl.innerHTML = "";

  const dolls = document.querySelectorAll("#doll-pool .game-doll");
  const totalCount = dolls.length;

  if (totalCount === 0) {
    pieChart.style.background = "#eee";
    legendEl.innerHTML = "无娃娃";
    return;
  }

  // 1. 统计当前池子里每种类型的数量
  const counts = {};
  dolls.forEach((d) => {
    const type = d.dataset.type;
    counts[type] = (counts[type] || 0) + 1;
  });

  // 2. 生成饼图 CSS 和 图例
  let gradientStr = "";
  let currentDeg = 0;

  // 遍历配置表是为了保证颜色和顺序一致，但数据用的是上面统计的 counts
  let hasData = false;

  REWARD_TIERS.forEach((tier, index) => {
    const count = counts[tier.type] || 0;
    if (count > 0) {
      hasData = true;
      const percent = count / totalCount;
      const degrees = percent * 360;
      const endDeg = currentDeg + degrees;

      // 拼接 CSS
      gradientStr += `${tier.color} ${currentDeg}deg ${endDeg}deg`;
      // 如果不是最后一段，加逗号
      // 这里有个小逻辑问题：forEach里面很难判断是不是最后一个有数据的tier
      // 所以我们加个简单的逗号处理逻辑：在每次添加前检查是否需要加逗号

      currentDeg = endDeg;

      // 生成图例
      const legendItem = document.createElement("div");
      legendItem.className = "legend-item";
      legendItem.innerHTML = `
                <div class="legend-dot" style="background: ${tier.color}"></div>
                <span>${tier.label} ${count}个</span>
            `;
      legendEl.appendChild(legendItem);
    }
  });

  // 修复 CSS 逗号问题：简单的做法是直接用逗号拼接，最后如果有逗号不影响（CSS宽容度），
  // 或者更严谨地处理。这里我们重组一下 gradientStr
  // 上面的循环直接拼会有问题，我们改用 map + join

  let gradients = [];
  currentDeg = 0;
  REWARD_TIERS.forEach((tier) => {
    const count = counts[tier.type] || 0;
    if (count > 0) {
      const percent = count / totalCount;
      const degrees = percent * 360;
      const endDeg = currentDeg + degrees;
      gradients.push(`${tier.color} ${currentDeg}deg ${endDeg}deg`);
      currentDeg = endDeg;
    }
  });

  if (gradients.length > 0) {
    pieChart.style.background = `conic-gradient(${gradients.join(", ")})`;
  } else {
    pieChart.style.background = "#eee";
  }
}

function getRandomRewardTier() {
  const totalWeight = REWARD_TIERS.reduce((sum, item) => sum + item.prob, 0);
  let randomNum = Math.random() * totalWeight;
  for (let tier of REWARD_TIERS) {
    if (randomNum < tier.prob) return tier;
    randomNum -= tier.prob;
  }
  return REWARD_TIERS[0];
}

// 重置/刷新娃娃机
async function resetClawMachine() {
  // 增加刷新动画反馈
  const pool = document.getElementById("doll-pool");
  pool.style.opacity = "0";

  clawState.x = 50;
  clawState.y = 0;
  clawState.isGrabbing = false;
  updateClawPosition();

  await new Promise((r) => setTimeout(r, 200)); // 稍作停顿
  pool.innerHTML = "";

  const availableImages = await db.clawMachineDolls.toArray();
  if (availableImages.length === 0) {
    pool.innerHTML =
      '<div style="text-align:center; padding-top:100px; color:#fff;">无图库...<br>请点击⚙️添加</div>';
    pool.style.opacity = "1";
    return;
  }

  const count = Math.floor(Math.random() * 6) + 10; // 10-15个

  for (let i = 0; i < count; i++) {
    const tierConfig = getRandomRewardTier();
    const imageObj =
      availableImages[Math.floor(Math.random() * availableImages.length)];

    const doll = document.createElement("div");
    doll.className = "game-doll";
    doll.dataset.type = tierConfig.type;
    doll.dataset.value = tierConfig.value;
    doll.dataset.label = tierConfig.label;

    doll.style.backgroundImage = `url(${imageObj.url})`;
    doll.style.left = Math.random() * 80 + "%";
    doll.style.bottom = Math.random() * 40 + "px";
    doll.style.transform = `rotate(${Math.random() * 60 - 30}deg)`;

    pool.appendChild(doll);
  }

  pool.style.opacity = "1";
  document.getElementById("claw-grab-btn").disabled = false;

  // ★★★ 关键：生成完娃娃后，立即计算并渲染饼图 ★★★
  renderRealTimeStats();
}

function updateClawPosition() {
  const claw = document.getElementById("machine-claw");
  clawState.x = Math.max(5, Math.min(95, clawState.x));
  claw.style.left = `${clawState.x}%`;
}

function initJoystick() {
  const joystick = document.getElementById("machine-joystick");
  const newJoystick = joystick.cloneNode(true);
  joystick.parentNode.replaceChild(newJoystick, joystick);

  const activeJoystick = document.getElementById("machine-joystick");
  let isDragging = false;
  let startX = 0;

  const startMove = (e) => {
    if (clawState.isGrabbing) return;
    isDragging = true;
    startX = e.type.includes("mouse") ? e.clientX : e.touches[0].clientX;
    activeJoystick.style.transition = "none";
  };

  const move = (e) => {
    if (!isDragging) return;
    e.preventDefault();
    const currentX = e.type.includes("mouse")
      ? e.clientX
      : e.touches[0].clientX;
    const deltaX = currentX - startX;
    const maxDist = 20;
    const moveX = Math.max(-maxDist, Math.min(maxDist, deltaX));
    activeJoystick.style.transform = `translate(calc(-50% + ${moveX}px), -50%)`;
    if (Math.abs(moveX) > 5) {
      clawState.x += moveX * 0.05;
      updateClawPosition();
    }
  };

  const endMove = () => {
    isDragging = false;
    activeJoystick.style.transition = "transform 0.2s";
    activeJoystick.style.transform = `translate(-50%, -50%)`;
  };

  activeJoystick.addEventListener("mousedown", startMove);
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", endMove);
  activeJoystick.addEventListener("touchstart", startMove);
  document.addEventListener("touchmove", move);
  document.addEventListener("touchend", endMove);
}

// 刷新按钮功能
async function handleRestartClaw() {
  // 可以设置是否扣费刷新，这里暂定为免费
  // 如果要扣费：
  /*
    if (state.globalSettings.userBalance < 5) { alert('余额不足5元，无法刷新'); return; }
    await updateUserBalanceAndLogTransaction(-5, "刷新娃娃机");
    updateClawBalanceDisplay();
    */

  const btn = document.getElementById("claw-restart-btn");
  btn.classList.add("rotating"); // 加一个旋转动画class效果更好
  await resetClawMachine();
  setTimeout(() => btn.classList.remove("rotating"), 500);
}

async function handleGrab() {
  if (clawState.isGrabbing) return;
  clawState.isGrabbing = true;

  // 每次抓取扣除 2 元 (在此处实现投币逻辑)
  // if ((state.globalSettings.userBalance || 0) < 2) {
  //     alert("余额不足 2 元，无法启动！");
  //     clawState.isGrabbing = false;
  //     return;
  // }
  // await updateUserBalanceAndLogTransaction(-2, "娃娃机投币");
  // updateClawBalanceDisplay();

  const btn = document.getElementById("claw-grab-btn");
  const claw = document.getElementById("machine-claw");
  btn.disabled = true;

  // 1. 下落
  claw.style.transition = "top 1s ease-in";
  claw.style.top = "70%";

  await new Promise((r) => setTimeout(r, 1000));

  // 2. 抓取
  claw.classList.add("grabbing");

  // 3. 碰撞检测
  const clawRect = claw.getBoundingClientRect();
  const dolls = document.querySelectorAll("#doll-pool .game-doll"); // 确保只选池子里的
  let caughtDoll = null;
  let minDistance = Infinity;

  dolls.forEach((doll) => {
    const dollRect = doll.getBoundingClientRect();
    const dist = Math.abs(
      clawRect.left + clawRect.width / 2 - (dollRect.left + dollRect.width / 2),
    );
    if (dist < 30) {
      if (dist < minDistance) {
        minDistance = dist;
        caughtDoll = doll;
      }
    }
  });

  // 4. 上升
  if (caughtDoll) {
    caughtDoll.classList.add("caught");
    caughtDoll.style.left = "50%";
    caughtDoll.style.top = "10px";
    caughtDoll.style.bottom = "auto";
    caughtDoll.style.transform = "translate(-50%, 0)";
    claw.appendChild(caughtDoll);
  }

  await new Promise((r) => setTimeout(r, 500));
  claw.style.transition = "top 1s ease-out";
  claw.style.top = "0";

  await new Promise((r) => setTimeout(r, 1000));

  // 5. 移到出口
  claw.style.transition = "left 1s linear";
  claw.style.left = "15%";

  await new Promise((r) => setTimeout(r, 1000));

  // 6. 松开
  claw.classList.remove("grabbing");

  if (caughtDoll) {
    caughtDoll.style.transition = "top 0.5s ease-in";
    caughtDoll.style.top = "200px"; // 掉落动画

    await new Promise((r) => setTimeout(r, 500));

    const type = caughtDoll.dataset.type;
    let value = parseFloat(caughtDoll.dataset.value);
    const label = caughtDoll.dataset.label;
    let message = "";

    if (type === "mystery") {
      const input = await showCustomPrompt(
        "抓到神秘娃娃！",
        "请输入你想获得的金额:",
        "",
        "number",
      );
      if (input !== null) {
        value = parseFloat(input);
        if (isNaN(value)) value = 0;
        message = `神秘力量生效！余额增加了 ¥${value.toFixed(2)}`;
      } else {
        value = 0;
        message = "你放弃了神秘奖励。";
      }
    } else if (value < 0) {
      message = `哎呀！抓到了恶作剧娃娃！扣除 ¥${Math.abs(value)}`;
    } else {
      message = `恭喜！抓到了 ${label} 娃娃，获得 ¥${value}！`;
    }

    if (value !== 0) {
      if (window.updateUserBalanceAndLogTransaction) {
        await window.updateUserBalanceAndLogTransaction(value, "抓娃娃机奖励");
      }
      updateClawBalanceDisplay();
      if (typeof renderBalanceDetails === "function")
        await renderBalanceDetails();
    }

    alert(message);
    caughtDoll.remove();

    // ★★★ 抓走娃娃后，池子里的娃娃变少了，重新计算概率饼图 ★★★
    renderRealTimeStats();
  } else {
    await showCustomPrompt(
      "好可惜！",
      "差一点点就抓到了！再试一次？",
      "加油",
      "text",
    );
  }

  // 7. 复位
  claw.style.transition = "left 0.5s ease";
  claw.style.left = "50%";
  clawState.x = 50;

  await new Promise((r) => setTimeout(r, 500));
  clawState.isGrabbing = false;
  btn.disabled = false;
}

// 娃娃管理逻辑 (保持不变)
async function openDollManager() {
  await renderDollManagerGrid();
  document.getElementById("doll-manager-modal").classList.add("visible");
}

async function renderDollManagerGrid() {
  const grid = document.getElementById("doll-manager-grid");
  grid.innerHTML = "";
  const dolls = await db.clawMachineDolls.toArray();

  dolls.forEach((doll) => {
    const item = document.createElement("div");
    item.style.cssText = `
            position: relative; width: 80px; height: 80px;
            background-image: url(${doll.url}); background-size: cover; background-position: center;
            border-radius: 10px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        `;
    const delBtn = document.createElement("div");
    delBtn.innerHTML = "×";
    delBtn.style.cssText = `
            position: absolute; top: -5px; right: -5px; width: 20px; height: 20px;
            background: #ff4d4f; color: white; border-radius: 50%; text-align: center; line-height: 18px;
            cursor: pointer; font-weight: bold;
        `;
    delBtn.onclick = async () => {
      if (confirm("确定要删除这个娃娃吗？")) {
        await db.clawMachineDolls.delete(doll.id);
        renderDollManagerGrid();
      }
    };
    item.appendChild(delBtn);
    grid.appendChild(item);
  });
}

async function handleAddDoll() {
  const choice = await showChoiceModal("添加娃娃", [
    { text: "📁 本地上传 (支持多选)", value: "local" },
    { text: "🌐 网络URL", value: "url" },
  ]);
  if (choice === "local") {
    document.getElementById("doll-upload-input").click();
  } else if (choice === "url") {
    const url = await showCustomPrompt("输入URL", "请输入图片的链接");
    if (url && url.trim()) {
      await db.clawMachineDolls.add({ url: url.trim() });
      renderDollManagerGrid();
    }
  }
}

async function handleDollFileChange(e) {
  const files = e.target.files;
  if (!files.length) return;
  for (const file of files) {
    const base64 = await handleImageUploadAndCompress(file);
    await db.clawMachineDolls.add({ url: base64 });
  }
  renderDollManagerGrid();
  e.target.value = null;
}

async function resetDefaultDolls() {
  if (confirm("确定要清空所有娃娃并恢复默认吗？")) {
    await db.clawMachineDolls.clear();
    const dollObjects = DEFAULT_DOLL_IMAGES.map((url) => ({ url: url }));
    await db.clawMachineDolls.bulkAdd(dollObjects);
    renderDollManagerGrid();
    alert("已恢复默认娃娃！");
  }
}

/* --- 娃娃机逻辑结束 --- */

/**
 * 核心函数：更新用户余额并记录一笔交易
 * @param {number} amount - 交易金额 (正数为收入, 负数为支出)
 * @param {string} description - 交易描述 (例如: "转账给 XX", "收到 XX 的红包")
 */
async function updateUserBalanceAndLogTransaction(amount, description) {
  if (isNaN(amount)) return; // 安全检查

  // 确保余额是数字
  state.globalSettings.userBalance =
    (state.globalSettings.userBalance || 0) + amount;

  const newTransaction = {
    type: amount > 0 ? "income" : "expense",
    amount: Math.abs(amount),
    description: description,
    timestamp: Date.now(),
  };

  // 使用数据库事务，确保两步操作要么都成功，要么都失败
  await db.transaction(
    "rw",
    db.globalSettings,
    db.userWalletTransactions,
    async () => {
      await db.globalSettings.put(state.globalSettings);
      await db.userWalletTransactions.add(newTransaction);
    },
  );

  console.log(
    `用户钱包已更新: 金额=${amount.toFixed(2)}, 新余额=${state.globalSettings.userBalance.toFixed(2)}`,
  );
}

/**
 * 处理删除单条交易记录（收入或支出）
 * @param {number} transactionId - 要删除的交易记录的ID
 */
async function handleDeleteTransaction(transactionId) {
  // 1. 在弹出确认框之前，先从数据库获取这条记录的详细信息
  const transaction = await db.userWalletTransactions.get(transactionId);
  if (!transaction) {
    await showCustomAlert("错误", "找不到该条交易记录，可能已被删除。");
    return;
  }

  // 根据记录类型，生成动态的、更清晰的提示信息
  const actionText = transaction.type === "income" ? "扣除" : "返还";
  const confirmMessage = `确定要删除这条【${
    transaction.type === "income" ? "收入" : "支出"
  }】记录吗？<br><br>此操作会将 <strong>¥${transaction.amount.toFixed(2)}</strong> 从您的余额中**${actionText}**。`;

  const confirmed = await showCustomConfirm("确认删除", confirmMessage, {
    confirmButtonClass: "btn-danger",
  });

  if (!confirmed) {
    return; // 如果用户取消，则不执行任何操作
  }

  try {
    // 2. 使用数据库事务来保证数据安全
    await db.transaction(
      "rw",
      db.globalSettings,
      db.userWalletTransactions,
      async () => {
        // 根据记录类型，决定是加余额还是减余额
        if (transaction.type === "income") {
          // 如果删除的是一笔收入，那么总余额应该减少
          state.globalSettings.userBalance -= transaction.amount;
        } else if (transaction.type === "expense") {
          // 如果删除的是一笔支出，那么总余额应该增加（钱被“退回”了）
          state.globalSettings.userBalance += transaction.amount;
        }

        // 3. 更新全局设置
        await db.globalSettings.put(state.globalSettings);

        // 4. 从交易记录表中删除这条记录
        await db.userWalletTransactions.delete(transactionId);
      },
    );

    // 5. 操作成功后，刷新UI
    await renderBalanceDetails();

    await showCustomAlert("操作成功", "该条记录已删除，余额已更新。");
  } catch (error) {
    console.error("删除交易记录时出错:", error);
    await showCustomAlert("操作失败", `发生错误: ${error.message}`);
  }
}

/**
 * 渲染“我的”页面的余额和交易明细 (支持删除所有记录)
 */
async function renderBalanceDetails() {
  // 1. 渲染当前余额
  const balance = state.globalSettings.userBalance || 0;
  document.getElementById("user-balance-display").textContent =
    `¥ ${balance.toFixed(2)}`;

  // 2. 渲染交易明细列表
  const listEl = document.getElementById("balance-details-list");
  listEl.innerHTML = ""; // 清空旧列表

  const transactions = await db.userWalletTransactions
    .reverse()
    .sortBy("timestamp");

  if (transactions.length === 0) {
    listEl.innerHTML =
      '<p style="text-align: center; color: var(--text-secondary); margin-top: 20px;">还没有任何明细记录</p>';
    return;
  }

  // 给列表加个标题
  listEl.innerHTML =
    '<h3 style="margin-bottom: 10px; color: var(--text-secondary);">余额明细</h3>';

  transactions.forEach((item) => {
    const itemEl = document.createElement("div");
    itemEl.className = "transaction-item";
    const sign = item.type === "income" ? "+" : "-";

    // 移除了 if 判断，现在为每一条记录都生成删除按钮
    const deleteButtonHtml = `<button class="delete-transaction-btn" data-transaction-id="${item.id}">×</button>`;

    itemEl.innerHTML = `
            <div class="transaction-info">
                <div class="description">${item.description}</div>
                <div class="timestamp">${new Date(item.timestamp).toLocaleString()}</div>
            </div>
            <div class="transaction-amount-wrapper">
                <div class="transaction-amount ${item.type}">
                    ${sign} ${item.amount.toFixed(2)}
                </div>
                ${deleteButtonHtml} 
            </div>
        `;
    listEl.appendChild(itemEl);
  });
}

/**
 * 初始化事件监听器 (仅保留娃娃机相关事件，桃宝/饿了么功能已移除)
 */
function initTaobao() {
  // 绑定娃娃机内部按钮
  const closeClawMachineBtn = document.getElementById("close-claw-machine");
  if (closeClawMachineBtn) {
    closeClawMachineBtn.addEventListener("click", () => {
      document.getElementById("claw-machine-modal").classList.remove("visible");
    });
  }

  const grabBtn = document.getElementById("claw-grab-btn");
  if (grabBtn) {
    // 使用 cloneNode 移除旧的监听器，防止重复绑定 (可选，更安全)
    const newGrabBtn = grabBtn.cloneNode(true);
    grabBtn.parentNode.replaceChild(newGrabBtn, grabBtn);
    newGrabBtn.addEventListener("click", handleGrab);
  }

  // ★★★ 绑定管理按钮 (Gear icon) ★★★
  const manageBtn = document.getElementById("claw-manage-btn");
  if (manageBtn) {
    manageBtn.addEventListener("click", openDollManager);
  }

  // ★★★ 绑定刷新按钮 (Restart icon) ★★★
  const restartBtn = document.getElementById("claw-restart-btn");
  if (restartBtn) {
    restartBtn.addEventListener("click", handleRestartClaw);
  }

  // 管理弹窗内的按钮
  const closeDollManagerBtn = document.getElementById("close-doll-manager-btn");
  if (closeDollManagerBtn) {
    closeDollManagerBtn.addEventListener("click", () => {
      document.getElementById("doll-manager-modal").classList.remove("visible");
      // 关闭管理窗口时，自动刷新一下娃娃机，以便显示用户刚上传的图
      resetClawMachine();
    });
  }

  const addDollBtn = document.getElementById("add-doll-btn");
  if (addDollBtn) {
    addDollBtn.addEventListener("click", handleAddDoll);
  }

  const resetDollsBtn = document.getElementById("reset-dolls-btn");
  if (resetDollsBtn) {
    resetDollsBtn.addEventListener("click", resetDefaultDolls);
  }

  const dollUploadInput = document.getElementById("doll-upload-input");
  if (dollUploadInput) {
    dollUploadInput.addEventListener("change", handleDollFileChange);
  }
}
