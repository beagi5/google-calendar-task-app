// 「今日は〇〇の日」の判定と、やることカードの「今日の目標」の振り分け。
// どちらも副作用の無い関数で、画面の部品から切り離してある(src/utils/day.test.js で単体テストする)。
// 日付はローカル時間で見る(week.js と同じ)。
import { getWeekBucket } from './week';

// 予定の件名が「シフト：入り」の形か。全角のコロン「：」も半角の「:」も読む
const SHIFT_PREFIX = /^シフト[：:]/;

// 画面は予定を完了にすると件名の頭に「[完了] 」を付ける(HomePage の EVENT_COMPLETED_PREFIX)。
// シフトの予定をうっかり完了にしても、帯が消えないように読み飛ばす
const COMPLETED_PREFIX = /^\[完了\]\s*/;

// 知っているシフトの名前 → 2行目の文と、今日の目標の数(1つ＝1コマ＝60分)。
// 数は yarukoto の「週に入れるコマの数」(2026-10-21 本人の指定)に合わせる: 入り 6／明け 6(18時締め)／
// 日勤 3(18時以降)／休予 0。
// 休みの使い方は、月の計画で本人が決めたものをシフト名に書く(2026-10-21 本人の選択「カレンダーのシフト名に書く」):
//   「休み（事業）」＝事業のコマを入れる日 8／「休み（撮影）」「休み（休む）」＝0／「休み」のまま＝未決(目標は出さない)
// 使える時間の目安から、その日の予定(MTG など)は差し引かない(2026-10-20 本人の選択)
const KNOWN_SHIFTS = new Map([
  ['入り', { hint: '使える時間の目安: 1時間 × 6', goal: 6 }],
  ['明け', { hint: '使える時間の目安: 1時間 × 6（18時まで。仮眠が短い日は減らす）', goal: 6 }],
  ['日勤', { hint: '使える時間の目安: 18時以降に 1時間 × 3', goal: 3 }],
  ['休み（事業）', { hint: '事業に使う休み。使える時間の目安: 1時間 × 8', goal: 8 }],
  ['休み（撮影）', { hint: '撮影の日（事業のコマは入れない）', goal: 0 }],
  ['休み（休む）', { hint: '休むと決めた日（事業の作業は入れない）', goal: 0 }],
  [
    '休み',
    {
      hint: '休みの使い方が決まっていません（事業に使う日は 1時間 × 8。決めたらシフト名を「休み（事業）」「休み（撮影）」「休み（休む）」に）',
      goal: null,
    },
  ],
  ['休予', { hint: '事業の作業は入れない日（アイデアのメモのみ）', goal: 0 }],
]);

// 「休み(事業)」のような半角のかっこや、名前の中の空白も同じに読む
const normalizeKind = (kind) => kind.replace(/\(/g, '（').replace(/\)/g, '）').replace(/[\s　]+/g, '');

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
    const kind = normalizeKind(summary.slice(prefix[0].length));
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

// やることの行の週('thisWeek'/'nextWeek'/'later')。
// 「今週」は Notion の今週ビューと同じく「予定週が明日以前」(2026-10-21〜)。先週以前の未済の持ち越しも入り、
// 日曜は翌週の月曜(＝明日)の行も今週に出る。それ以外は week.js の getWeekBucket(来週／後で)。
// 予定週は 'YYYY-MM-DD' なので文字列のまま比べられる
export const yarukotoWeekBucket = (weekStart, now = new Date()) => {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  const tomorrowISO = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  if (typeof weekStart === 'string' && weekStart !== '' && weekStart <= tomorrowISO) return 'thisWeek';
  return getWeekBucket(weekStart, now);
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
