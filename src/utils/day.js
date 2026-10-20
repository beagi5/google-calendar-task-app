// 「今日は〇〇の日」の判定と、やることカードの「今日の目標」の振り分け。
// どちらも副作用の無い関数で、画面の部品から切り離してある(src/utils/day.test.js で単体テストする)。
// 日付はローカル時間で見る(week.js と同じ)。

// 予定の件名が「シフト：入り」の形か。全角のコロン「：」も半角の「:」も読む
const SHIFT_PREFIX = /^シフト[：:]/;

// 画面は予定を完了にすると件名の頭に「[完了] 」を付ける(HomePage の EVENT_COMPLETED_PREFIX)。
// シフトの予定をうっかり完了にしても、帯が消えないように読み飛ばす
const COMPLETED_PREFIX = /^\[完了\]\s*/;

// 知っているシフトの名前 → 2行目の文と、今日の目標の数。
// 使える時間の目安から、その日の予定(MTG など)は差し引かない。
// 休予(休みの予定)はカレンダーに名前が無く、休みと見分けられない扱い: どちらも目標は 0。
// 「休予」という名前の予定が来たときも、休みと同じに読む
const REST_DAY = { hint: '事業の作業は入れない日（撮影・ロケハンのみ）', goal: 0 };
const KNOWN_SHIFTS = new Map([
  ['入り', { hint: '使える時間の目安: 1時間 × 2', goal: 2 }],
  ['明け', { hint: '使える時間の目安: 1時間 × 4（18時まで。仮眠が短い日は減らす）', goal: 4 }],
  ['日勤', { hint: '使える時間の目安: 18時以降に軽いものを1つ', goal: 1 }],
  ['休み', REST_DAY],
  ['休予', REST_DAY],
]);

export const NO_SHIFT_LINE = '今日のシフトがカレンダーにありません';

// 今日の予定(/api/calendar/events の today)から、今日がどんな日かを読む。
// 件名が「シフト：」で始まる最初の予定を使う。コロンの後ろ(前後の空白は除く)が種類。
// 返すもの:
//   kind  種類の名前(シフトの予定が無ければ null)
//   line1 1行目の文
//   line2 2行目の文(目安が無ければ null)
//   goal  今日の目標の数。知らない名前・シフトの予定が無いときは null(=目標は出さない)
export const getDayInfo = (events) => {
  for (const event of Array.isArray(events) ? events : []) {
    const summary = typeof event?.summary === 'string' ? event.summary.trim().replace(COMPLETED_PREFIX, '') : '';
    const prefix = SHIFT_PREFIX.exec(summary);
    if (!prefix) continue;
    const kind = summary.slice(prefix[0].length).trim();
    if (kind === '') continue;
    const known = KNOWN_SHIFTS.get(kind);
    return {
      kind,
      line1: `今日は${kind}の日`,
      line2: known ? known.hint : null,
      goal: known ? known.goal : null,
    };
  }
  return { kind: null, line1: NO_SHIFT_LINE, line2: null, goal: null };
};

// ISO の日時の文字列('2026-10-20T08:15:30.123Z' など)が、now と同じローカルの日か。読めない値は false
export const isSameLocalDay = (value, now = new Date()) => {
  if (typeof value !== 'string' || value === '') return false;
  const date = new Date(value);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
};

// やることカードの「今週」の見せ方を決める。
//   rows        カテゴリのボタンで絞ったあとの行(サーバーが優先の順に並べたまま。どの週の行も入っている)
//   goal        今日の目標の数(getDayInfo の goal)。null は「目標は出さない」
//   isThisWeek  行が「今週」の行か(先週以前の未済の持ち越しを含む。画面の振り分けと同じものを渡す)
//   now         今日(既定は今)
// 今日済ませた行 = 済、かつ最終更新(lastEdited)がローカルの今日。どの週の行でも数える。
//
// 返すもの(mode ごと):
//   'goal'  目標が 1 以上: goalRows(今日済ませた行 → 今週の未済を優先の順に、合わせて目標の数まで。
//           今日済ませた行が目標より多いときは、その全部)、extraRows(今週の未済の残り=できたら前倒し)、
//           doneCount(今日済ませた数。目標を超えない)、achieved(今日済ませた数が目標の数以上)
//   'rest'  目標が 0(休み): listRows(今日済ませた行 → 今週の未済。画面では畳んでおく)
//   'free'  目標が null: listRows(同じ。1本の一覧で出す)
//   どれにも doneEarlierCount(今週の、今日より前に済んだ行の数=一覧に出さず件数だけ出す)がある
export const planYarukoto = ({ rows, goal, isThisWeek, now = new Date() }) => {
  const isDoneToday = (row) => row.done && isSameLocalDay(row.lastEdited, now);
  const doneToday = rows.filter(isDoneToday);
  const thisWeek = rows.filter(isThisWeek);
  const open = thisWeek.filter((row) => !row.done);
  const doneEarlierCount = thisWeek.filter((row) => row.done && !isDoneToday(row)).length;

  if (typeof goal === 'number' && goal > 0) {
    const need = Math.max(0, goal - doneToday.length);
    return {
      mode: 'goal',
      goal,
      goalRows: [...doneToday, ...open.slice(0, need)],
      extraRows: open.slice(need),
      doneCount: Math.min(doneToday.length, goal),
      achieved: doneToday.length >= goal,
      doneEarlierCount,
    };
  }
  return {
    mode: goal === 0 ? 'rest' : 'free',
    goal: goal === 0 ? 0 : null,
    listRows: [...doneToday, ...open],
    doneEarlierCount,
  };
};
