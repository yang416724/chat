#!/usr/bin/env python3
"""Find matching closing </div> for a div opening at a given line number.
Tracks nesting depth based on <div ... > and </div> tags on each line.
Usage: python3 find_close.py <file> <start_line_number>
The start_line_number should be the line that contains the opening <div ... id="..." ...> tag.
Prints the line number of the matching closing </div> (1-indexed).
"""
import re
import sys

def main():
    path = sys.argv[1]
    start = int(sys.argv[2])
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    # 1-indexed; the opening tag is on line `start`
    idx = start - 1
    line = lines[idx]
    # Count opening divs on the start line (should be at least 1)
    # We treat each <div ... > as +1 and each </div> as -1.
    open_re = re.compile(r'<div\b', re.IGNORECASE)
    close_re = re.compile(r'</div>', re.IGNORECASE)
    depth = 0
    # process start line
    depth += len(open_re.findall(line)) - len(close_re.findall(line))
    i = idx + 1
    n = len(lines)
    while i < n:
        l = lines[i]
        o = len(open_re.findall(l))
        c = len(close_re.findall(l))
        depth += o - c
        if depth == 0:
            # this line contains the matching close
            print(i + 1)
            return
        i += 1
    print("NOT_FOUND", file=sys.stderr)

if __name__ == '__main__':
    main()
