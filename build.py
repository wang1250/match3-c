#!/usr/bin/env python3
"""
甜甜消消乐 · C/WebAssembly 构建脚本
=====================================
把 match3_core.c 编译为 WebAssembly，内嵌进 index.html 模板，
生成单文件、可双击运行的 index.html。

用法:
    python build.py

要求:
    - Python 3
    - Zig 编译器 (提供 zig cc，支持 wasm32-freestanding 目标)
      可从 https://ziglang.org/download/ 下载，或设置环境变量 ZIG 指向 zig.exe

构建流程:
    1. 扫描 match3_core.c 中所有 m3_* 导出函数
    2. 用 zig cc 编译为 match3.wasm
    3. 把 wasm 转为 base64，注入 src/app.js 生成最终 index.html
"""

import base64
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
SRC = BASE / "src"
CORE = BASE / "match3_core.c"
WASM = BASE / "match3.wasm"
APP_TEMPLATE = SRC / "app.js"
PAGE_TEMPLATE = SRC / "page.template.html"
OUTPUT = BASE / "index.html"

# 定位 zig 编译器：优先环境变量 ZIG，其次 PATH，最后常见安装位置
def find_zig():
    candidates = []
    env = os.environ.get("ZIG")
    if env:
        candidates.append(Path(env))
    found = shutil.which("zig")
    if found:
        candidates.append(Path(found))
    candidates += [
        Path(r"D:\Users\lenovo\tools\zig-x86_64-windows-0.17.1\zig.exe"),
        Path("/usr/local/bin/zig"),
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def main():
    zig = find_zig()
    if not zig:
        sys.exit(
            "未找到 Zig 编译器。请从 https://ziglang.org/download/ 下载，"
            "或设置环境变量 ZIG 指向 zig.exe 后重试。"
        )
    if not CORE.exists() or not APP_TEMPLATE.exists() or not PAGE_TEMPLATE.exists():
        sys.exit("缺少源文件 (match3_core.c / src/app.js / src/page.template.html)。")

    source = CORE.read_text(encoding="utf-8")
    names = sorted(set(re.findall(r"\b(m3_[A-Za-z0-9_]+)\s*\(", source)))
    if not names:
        sys.exit("未在 C 源码中找到任何 m3_* 导出函数。")
    print("导出函数 (%d): %s" % (len(names), ", ".join(names)))

    # 编译 C -> wasm
    cmd = [
        str(zig), "cc", "-target", "wasm32-freestanding", "-O2",
        "-Wl,--no-entry", "-Wl,--export-memory",
    ]
    cmd += ["-Wl,--export=%s" % n for n in names]
    cmd += ["-o", str(WASM), str(CORE)]
    print("编译中...")
    subprocess.run(cmd, check=True)
    print("wasm 大小: %d 字节" % WASM.stat().st_size)

    # wasm -> base64 -> JS 胶水层
    b64 = base64.b64encode(WASM.read_bytes()).decode("ascii")
    js = APP_TEMPLATE.read_text(encoding="utf-8")
    if "__WASM_BASE64__" not in js:
        sys.exit("src/app.js 中缺少 __WASM_BASE64__ 占位符。")
    js = js.replace("__WASM_BASE64__", b64)

    # 注入 HTML 模板（保留原有界面、CSS 与音效逻辑）
    head = PAGE_TEMPLATE.read_text(encoding="utf-8").split("<script>", 1)[0]
    OUTPUT.write_text(head + "<script>\n" + js + "\n</script>\n</body>\n</html>\n", encoding="utf-8")
    print("已生成 %s (%d 字节)" % (OUTPUT.name, OUTPUT.stat().st_size))


if __name__ == "__main__":
    main()
