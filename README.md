# 甜甜消消乐 · C / WebAssembly 版

一个可直接运行的三消（消消乐）网页游戏。**游戏的全部核心逻辑由 C 语言编写并编译为 WebAssembly**，网页只负责界面渲染、动画和音效，因此同时保留了完整的图形化游戏原貌。

## 玩法

- 点击或拖动交换两个相邻糖果，只有凑成横向/纵向 **3 个及以上**同色才有效，否则自动换回。
- 4 连生成条纹糖（清整行/整列），T/L 形 5 连生成包装糖（炸 3×3），5 连直线生成彩糖炸弹（清全场同色）。
- 消除后上方糖果下落、顶部补充，可能触发连锁，连锁倍率逐层提高。
- 每关有步数限制，达成「收集指定颜色」或「达到目标分数」即过关；步数耗尽则失败。
- 提供提示、洗牌、+5 步三种道具（每关各 2 次）。
- 30 关进度保存在浏览器本地，通关自动解锁下一关。
- 首次点击页面后播放背景音乐，右上角可开关音乐与音效。

## 文件结构

| 文件 | 说明 |
| --- | --- |
| `index.html` | **成品**，单文件，双击即可在浏览器运行（已内嵌 wasm，无需服务器或联网） |
| `match3_core.c` | C 语言核心：棋盘生成、匹配判定、特殊糖果、掉落补充、计分、提示与洗牌 |
| `match3.wasm` | C 核心的 WebAssembly 编译产物（同时已 base64 内嵌进 index.html） |
| `src/app.js` | JS 胶水层：调用 wasm 导出函数，并用 DOM 播放动画、用 Web Audio 合成音效 |
| `src/page.template.html` | HTML / CSS 模板（界面与样式） |
| `build.py` | 构建脚本：编译 C → wasm 并注入模板生成 index.html |

## 重新构建

修改 C 核心后，运行构建脚本即可重新生成 `index.html`：

```bash
python build.py
```

需要 [Zig 编译器](https://ziglang.org/download/)（提供 `zig cc`）。若 zig 不在 PATH 中，可通过环境变量指定：

```bash
set ZIG=C:\path\to\zig.exe     # Windows
export ZIG=/path/to/zig        # macOS / Linux
```

脚本会自动扫描 `match3_core.c` 中所有 `m3_*` 函数作为 wasm 导出，编译成 `match3.wasm`，再转成 base64 注入 `src/app.js` 与 HTML 模板，得到最终单文件页面。

## 技术说明

- C 与 JS 通过 WebAssembly 线性内存交换数据：C 导出棋盘、匹配、消除、移动等数组的内存指针，JS 用 `Int32Array` 视图直接读写。
- 随机数使用 xorshift32 自行实现，不依赖 libc。
- 音频全部由 Web Audio 实时合成，不依赖外部音频文件。
- 浏览器需支持 WebAssembly（所有现代浏览器均支持）。

## 调试接口

页面在 `window.__match3` 上暴露了测试接口：

```js
__match3.state()       // 当前关卡/得分/步数/目标/道具
__match3.grid()        // 棋盘数据
__match3.validSwap()   // 一个可用交换
__match3.swap(r1,c1,r2,c2)
__match3.gotoLevel(n)  // 跳到指定关
__match3.engine()      // 返回 "C/WebAssembly"
```
