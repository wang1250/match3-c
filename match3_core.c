/*
 * 甜甜消消乐 - 核心逻辑（C 语言实现）
 * ------------------------------------------------------------------
 * 本文件负责三消游戏的所有纯逻辑：棋盘生成、匹配判定、特殊糖果、
 * 展开消除、掉落补充、计分、收集统计、提示与洗牌。
 * 编译为 WebAssembly 后由 index.html 调用，页面只负责 DOM 动画与音效。
 *
 * 编译命令（需要 Zig 自带的 clang）：
 *   zig cc -target wasm32-freestanding -O2 -Wl,--no-entry \
 *          -Wl,--export-all -o match3.wasm match3_core.c
 */

#define ROWS 8
#define COLS 8
#define NCELLS 64
#define MAX_CELLS 160
#define MAX_RUNS 32
#define NTYPES 6

/* 特殊糖果类型 */
#define SP_NONE    0
#define SP_HLINE   1   /* 条纹糖：清整行 */
#define SP_VLINE   2   /* 条纹糖：清整列 */
#define SP_WRAPPED 3   /* 包装糖：炸 3x3 */
#define SP_BOMB    4   /* 彩糖炸弹：清全场同色 */

/* ---------- 棋盘状态（导出给 JS 直接读取） ---------- */
int board_type[NCELLS];
int board_sp[NCELLS];

/* ---------- 随机数（xorshift32，不依赖 libc） ---------- */
unsigned rng_state = 0x9e3779b9u;

unsigned m3_rnd(unsigned n) {
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 17;
    rng_state ^= rng_state << 5;
    return rng_state % n;
}

void m3_seed(unsigned s) {
    rng_state = s ? s : 0x9e3779b9u;
}

/* ---------- 通用工具 ---------- */
static void add_unique(int *arr, int *count, int idx) {
    int i;
    for (i = 0; i < *count; i++) if (arr[i] == idx) return;
    if (*count < MAX_CELLS) arr[(*count)++] = idx;
}

static int contains(const int *arr, int count, int idx) {
    int i;
    for (i = 0; i < count; i++) if (arr[i] == idx) return 1;
    return 0;
}

static int idx_of(int r, int c) { return r * COLS + c; }

/* ---------- 匹配判定 ---------- */
int match_cells[MAX_CELLS];
int match_count;
int runs[MAX_RUNS * 4];   /* 每条 run: [dir(1横/2竖), type, start_idx, len] */
int run_count;

int m3_find_matches(void) {
    int r, c, e;
    match_count = 0;
    run_count = 0;

    /* 横向 */
    for (r = 0; r < ROWS; r++) {
        c = 0;
        while (c < COLS) {
            int t = board_type[idx_of(r, c)];
            if (t < 0) { c++; continue; }
            e = c + 1;
            while (e < COLS && board_type[idx_of(r, e)] == t) e++;
            if (e - c >= 3 && run_count < MAX_RUNS) {
                int k;
                runs[run_count * 4 + 0] = 1;
                runs[run_count * 4 + 1] = t;
                runs[run_count * 4 + 2] = idx_of(r, c);
                runs[run_count * 4 + 3] = e - c;
                run_count++;
                for (k = c; k < e; k++) add_unique(match_cells, &match_count, idx_of(r, k));
            }
            c = e;
        }
    }

    /* 纵向 */
    for (c = 0; c < COLS; c++) {
        r = 0;
        while (r < ROWS) {
            int t = board_type[idx_of(r, c)];
            if (t < 0) { r++; continue; }
            e = r + 1;
            while (e < ROWS && board_type[idx_of(e, c)] == t) e++;
            if (e - r >= 3 && run_count < MAX_RUNS) {
                int k;
                runs[run_count * 4 + 0] = 2;
                runs[run_count * 4 + 1] = t;
                runs[run_count * 4 + 2] = idx_of(r, c);
                runs[run_count * 4 + 3] = e - r;
                run_count++;
                for (k = r; k < e; k++) add_unique(match_cells, &match_count, idx_of(k, c));
            }
            r = e;
        }
    }
    return match_count;
}

/* ---------- 特殊糖果生成计划 ---------- */
int plan_cells[MAX_CELLS];
int plan_sp[MAX_CELLS];
int plan_count;

static int pick_cell(int start, int len, int dir, int pref) {
    int mid;
    int i;
    if (pref >= 0) {
        for (i = 0; i < len; i++) {
            int idx = dir == 1 ? start + i : start + i * COLS;
            if (idx == pref) return idx;
        }
    }
    mid = start + (len / 2) * (dir == 1 ? 1 : COLS);
    return mid;
}

void m3_plan_specials(int pref) {
    int i, j;
    plan_count = 0;

    for (i = 0; i < run_count; i++) {
        int dir = runs[i * 4 + 0];
        int len = runs[i * 4 + 3];
        int cell = pick_cell(runs[i * 4 + 2], len, dir, pref);
        int sp = SP_NONE;
        if (len >= 5) sp = SP_BOMB;
        else if (len == 4) sp = (dir == 1) ? SP_HLINE : SP_VLINE;
        if (sp != SP_NONE) {
            if (contains(plan_cells, plan_count, cell)) {
                /* 已计划：5 连优先覆盖 4 连 */
                if (sp == SP_BOMB) {
                    for (j = 0; j < plan_count; j++) if (plan_cells[j] == cell) plan_sp[j] = SP_BOMB;
                }
            } else if (plan_count < MAX_CELLS) {
                plan_cells[plan_count] = cell;
                plan_sp[plan_count++] = sp;
            }
        }
    }

    /* T / L 形：同色横竖交叉 -> 包装糖 */
    for (i = 0; i < run_count; i++) {
        if (runs[i * 4 + 0] != 1) continue;
        for (j = 0; j < run_count; j++) {
            int k, m;
            if (runs[j * 4 + 0] != 2) continue;
            if (runs[i * 4 + 1] != runs[j * 4 + 1]) continue;
            for (k = 0; k < runs[i * 4 + 3]; k++) {
                int hcell = runs[i * 4 + 2] + k;
                for (m = 0; m < runs[j * 4 + 3]; m++) {
                    int vcell = runs[j * 4 + 2] + m * COLS;
                    if (hcell != vcell) continue;
                    if (contains(plan_cells, plan_count, hcell)) {
                        for (int q = 0; q < plan_count; q++)
                            if (plan_cells[q] == hcell && plan_sp[q] != SP_BOMB) plan_sp[q] = SP_WRAPPED;
                    } else if (plan_count < MAX_CELLS) {
                        plan_cells[plan_count] = hcell;
                        plan_sp[plan_count++] = SP_WRAPPED;
                    }
                }
            }
        }
    }
}

/* ---------- 展开消除结果 ---------- */
int clear_cells[MAX_CELLS];
int clear_count;
int clear_score;
int clear_collected[NTYPES];

static int most_common_type(const int *cells, int count) {
    int counts[NTYPES];
    int i, best = -1, bestn = 0;
    for (i = 0; i < NTYPES; i++) counts[i] = 0;
    for (i = 0; i < count; i++) {
        int t = board_type[cells[i]];
        if (t >= 0 && t < NTYPES) counts[t]++;
    }
    for (i = 0; i < NTYPES; i++) if (counts[i] > bestn) { bestn = counts[i]; best = i; }
    return best;
}

static void expand_specials(int bomb_color) {
    int processed[MAX_CELLS];
    int pcount = 0;
    int changed = 1;
    while (changed) {
        int i;
        changed = 0;
        for (i = 0; i < clear_count; i++) {
            int idx = clear_cells[i];
            int sp = board_sp[idx];
            if (!sp || contains(processed, pcount, idx)) continue;
            if (pcount < MAX_CELLS) processed[pcount++] = idx;

            int r = idx / COLS, c = idx % COLS;
            int rr, cc;
            if (sp == SP_BOMB) {
                for (rr = 0; rr < ROWS; rr++) {
                    for (cc = 0; cc < COLS; cc++) {
                        int t = idx_of(rr, cc);
                        if (bomb_color == -2 || board_type[t] == bomb_color) {
                            if (!contains(clear_cells, clear_count, t)) {
                                add_unique(clear_cells, &clear_count, t);
                                changed = 1;
                            }
                        }
                    }
                }
            } else if (sp == SP_HLINE) {
                for (cc = 0; cc < COLS; cc++) {
                    if (!contains(clear_cells, clear_count, idx_of(r, cc))) {
                        add_unique(clear_cells, &clear_count, idx_of(r, cc));
                        changed = 1;
                    }
                }
            } else if (sp == SP_VLINE) {
                for (rr = 0; rr < ROWS; rr++) {
                    if (!contains(clear_cells, clear_count, idx_of(rr, c))) {
                        add_unique(clear_cells, &clear_count, idx_of(rr, c));
                        changed = 1;
                    }
                }
            } else if (sp == SP_WRAPPED) {
                for (rr = r - 1; rr <= r + 1; rr++) {
                    for (cc = c - 1; cc <= c + 1; cc++) {
                        if (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS) {
                            if (!contains(clear_cells, clear_count, idx_of(rr, cc))) {
                                add_unique(clear_cells, &clear_count, idx_of(rr, cc));
                                changed = 1;
                            }
                        }
                    }
                }
            }
        }
    }
}

/* chain: 连锁层数（第 1 次消除为 1） */
void m3_compute_clear(int chain, int bomb_color) {
    int i;
    clear_count = 0;
    clear_score = 0;
    for (i = 0; i < NTYPES; i++) clear_collected[i] = 0;

    /* 先排除特殊糖果生成格 */
    for (i = 0; i < match_count; i++) {
        if (!contains(plan_cells, plan_count, match_cells[i]))
            add_unique(clear_cells, &clear_count, match_cells[i]);
    }

    /* bomb_color: -1 = 自动取最常见颜色; -2 = 全场清除; 0..5 = 指定颜色 */
    if (bomb_color == -1) bomb_color = most_common_type(clear_cells, clear_count);
    expand_specials(bomb_color);

    /* 保护特殊糖果生成格，不能被连锁效果吞掉 */
    for (i = 0; i < plan_count; i++) {
        int idx = plan_cells[i];
        int j;
        for (j = 0; j < clear_count; j++) {
            if (clear_cells[j] == idx) {
                int k;
                for (k = j; k < clear_count - 1; k++) clear_cells[k] = clear_cells[k + 1];
                clear_count--;
                break;
            }
        }
    }

    for (i = 0; i < clear_count; i++) {
        int t = board_type[clear_cells[i]];
        if (t >= 0 && t < NTYPES) clear_collected[t]++;
    }
    clear_score = clear_count * 10 * chain + plan_count * 50;
}

/* ---------- 应用消除 + 重力 + 补充 ---------- */
int move_from[NCELLS];   /* 新位置 <- 旧位置，-1 表示新生成 */
int move_type[NCELLS];   /* 新生成糖果的类型 */

void m3_apply_clear(void) {
    int i, c, r, write;

    for (i = 0; i < clear_count; i++) {
        int idx = clear_cells[i];
        board_type[idx] = -1;
        board_sp[idx] = SP_NONE;
    }
    for (i = 0; i < plan_count; i++) {
        board_sp[plan_cells[i]] = plan_sp[i];
    }

    for (c = 0; c < COLS; c++) {
        int survivors[NCELLS];
        int scount = 0;
        for (r = ROWS - 1; r >= 0; r--) {
            int idx = idx_of(r, c);
            if (board_type[idx] >= 0) {
                if (scount < NCELLS) survivors[scount++] = idx;
            }
        }
        write = ROWS - 1;
        for (i = 0; i < scount; i++) {
            int old = survivors[i];
            int ni = idx_of(write, c);
            if (ni != old) {
                board_type[ni] = board_type[old];
                board_sp[ni] = board_sp[old];
                board_type[old] = -1;
                board_sp[old] = SP_NONE;
            }
            move_from[ni] = old;
            move_type[ni] = -1;
            write--;
        }
        while (write >= 0) {
            int ni = idx_of(write, c);
            int t = (int)(m3_rnd(NTYPES));
            board_type[ni] = t;
            board_sp[ni] = SP_NONE;
            move_from[ni] = -1;
            move_type[ni] = t;
            write--;
        }
    }
}

/* ---------- 棋盘生成 / 洗牌 ---------- */
static int would_match(int r, int c, int t) {
    if (c >= 2 && board_type[idx_of(r, c - 1)] == t && board_type[idx_of(r, c - 2)] == t) return 1;
    if (r >= 2 && board_type[idx_of(r - 1, c)] == t && board_type[idx_of(r - 2, c)] == t) return 1;
    return 0;
}

/* 返回 a*64+b+1（0 表示无可用交换），避免额外内存参数 */
int m3_find_valid_swap(void) {
    int r, c;
    for (r = 0; r < ROWS; r++) {
        for (c = 0; c < COLS; c++) {
            int a = idx_of(r, c);
            int b, ok;
            if (c + 1 < COLS) {
                b = idx_of(r, c + 1);
                int tt = board_type[a]; board_type[a] = board_type[b]; board_type[b] = tt;
                ok = (m3_find_matches() > 0) ||
                     (board_sp[a] == SP_BOMB) || (board_sp[b] == SP_BOMB) ||
                     (board_sp[a] != SP_NONE && board_sp[b] != SP_NONE);
                tt = board_type[a]; board_type[a] = board_type[b]; board_type[b] = tt;
                if (ok) return a * NCELLS + b + 1;
            }
            if (r + 1 < ROWS) {
                b = idx_of(r + 1, c);
                int tt = board_type[a]; board_type[a] = board_type[b]; board_type[b] = tt;
                ok = (m3_find_matches() > 0) ||
                     (board_sp[a] == SP_BOMB) || (board_sp[b] == SP_BOMB) ||
                     (board_sp[a] != SP_NONE && board_sp[b] != SP_NONE);
                tt = board_type[a]; board_type[a] = board_type[b]; board_type[b] = tt;
                if (ok) return a * NCELLS + b + 1;
            }
        }
    }
    return 0;
}

/* 炸弹交换后的清除计算（调用前须先 m3_swap） */
void m3_bomb_clear(int a, int b, int chain) {
    int i;
    int color;
    plan_count = 0;
    clear_count = 0;
    clear_score = 0;
    for (i = 0; i < NTYPES; i++) clear_collected[i] = 0;
    add_unique(clear_cells, &clear_count, a);
    add_unique(clear_cells, &clear_count, b);
    if (board_sp[a] == SP_BOMB && board_sp[b] == SP_BOMB) color = -2;
    else if (board_sp[a] == SP_BOMB) color = (board_type[b] >= 0) ? board_type[b] : most_common_type(clear_cells, clear_count);
    else color = (board_type[a] >= 0) ? board_type[a] : most_common_type(clear_cells, clear_count);
    expand_specials(color);
    for (i = 0; i < clear_count; i++) {
        int t = board_type[clear_cells[i]];
        if (t >= 0 && t < NTYPES) clear_collected[t]++;
    }
    clear_score = clear_count * 12 * (chain > 0 ? chain : 1);
}

void m3_build_board(void) {
    int r, c, attempt;
    for (attempt = 0; attempt < 200; attempt++) {
        for (r = 0; r < ROWS; r++) {
            for (c = 0; c < COLS; c++) {
                int t, guard = 0;
                do { t = (int)(m3_rnd(NTYPES)); guard++; }
                while (would_match(r, c, t) && guard < 50);
                board_type[idx_of(r, c)] = t;
                board_sp[idx_of(r, c)] = SP_NONE;
            }
        }
        if (m3_find_matches() == 0 && m3_find_valid_swap()) break;
    }
}

void m3_shuffle(void) {
    int values[NCELLS];
    int i, attempt;
    for (i = 0; i < NCELLS; i++) values[i] = board_type[i];
    for (attempt = 0; attempt < 200; attempt++) {
        for (i = NCELLS - 1; i > 0; i--) {
            int j = (int)(m3_rnd((unsigned)(i + 1)));
            int tmp = values[i]; values[i] = values[j]; values[j] = tmp;
        }
        for (i = 0; i < NCELLS; i++) { board_type[i] = values[i]; board_sp[i] = SP_NONE; }
        if (m3_find_matches() == 0 && m3_find_valid_swap()) break;
    }
}

void m3_swap(int a, int b) {
    int t = board_type[a];
    board_type[a] = board_type[b];
    board_type[b] = t;
    t = board_sp[a];
    board_sp[a] = board_sp[b];
    board_sp[b] = t;
}

/* ---------- 供 JS 直接读取内存的指针访问器 ---------- */
/* 返回各数组在 wasm 线性内存中的字节偏移，JS 用 Int32Array 视图读取 */
int *m3_board_type_ptr(void)   { return board_type; }
int *m3_board_sp_ptr(void)     { return board_sp; }
int *m3_match_cells_ptr(void)  { return match_cells; }
int *m3_runs_ptr(void)         { return runs; }
int *m3_plan_cells_ptr(void)   { return plan_cells; }
int *m3_plan_sp_ptr(void)      { return plan_sp; }
int *m3_clear_cells_ptr(void)  { return clear_cells; }
int *m3_clear_collected_ptr(void) { return clear_collected; }
int *m3_move_from_ptr(void)    { return move_from; }
int *m3_move_type_ptr(void)    { return move_type; }

int m3_match_count(void)  { return match_count; }
int m3_run_count(void)    { return run_count; }
int m3_plan_count(void)   { return plan_count; }
int m3_clear_count(void)  { return clear_count; }
int m3_clear_score(void)  { return clear_score; }
