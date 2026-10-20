import React from 'react';

// Notion「やること」の1行。
// 普段はチェック・名前・小さなバッジ(カテゴリ・プロジェクト・締切・滞留)だけ。
// 名前を押すと開いて、完了条件・出典(URL ならリンク)・「Notionで開く」が出る。もう一度押すと閉じる。
// チェックを押しても開閉しない。
// 開いているかどうか(open)は親が持つ: 行が「今日の目標」と「できたら前倒し」の間を動いても、開いたままにするため。
// カテゴリのバッジ色は TaskItem と同じ CSS クラスを使う(TaskItem.js 自体は変えない)。
const CATEGORY_BADGE_CLASS = {
  'YCDC': 'category-badge-ycdc',
  '事業': 'category-badge-business',
  '株': 'category-badge-stock',
  'マネジメント': 'category-badge-management',
  'その他': 'category-badge-other',
};

// 'YYYY-MM-DD' -> 'M/D'
const formatDeadline = (isoDate) => {
  const [, m, d] = isoDate.split('-');
  return `${Number(m)}/${Number(d)}`;
};

// href に入れてよいのは http(s) のアドレスだけ
const isWebUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);

const YarukotoItem = ({ item, open = false, disabled = false, onToggle, onToggleOpen }) => {
  const detailsId = `yarukoto-details-${item.id}`;
  return (
    <div className={`yarukoto-item${item.done ? ' completed' : ''}${open ? ' open' : ''}`}>
      <input
        type="checkbox"
        checked={!!item.done}
        disabled={disabled}
        aria-label={item.title}
        onChange={() => onToggle(item)}
      />
      <div className="yarukoto-item-body">
        <button
          type="button"
          className="yarukoto-item-toggle"
          aria-expanded={open}
          aria-controls={open ? detailsId : undefined}
          onClick={() => onToggleOpen(item)}
        >
          <span className="yarukoto-item-title">{item.title}</span>
        </button>
        <div className="yarukoto-item-meta">
          {item.category && (
            <span className={`category-badge ${CATEGORY_BADGE_CLASS[item.category] || ''}`}>{item.category}</span>
          )}
          {item.project && <span className="category-badge yarukoto-badge-project">{item.project}</span>}
          {item.deadline && (
            <span className="category-badge yarukoto-badge-deadline" title="締切">{formatDeadline(item.deadline)}</span>
          )}
          {item.stale && <span className="category-badge yarukoto-badge-stale">{item.stale}</span>}
        </div>
        {open && (
          <div className="yarukoto-item-details" id={detailsId}>
            {item.criteria && (
              <div className="yarukoto-detail">
                <div className="yarukoto-detail-label">完了条件</div>
                <div className="yarukoto-detail-text">{item.criteria}</div>
              </div>
            )}
            {item.source && (
              <div className="yarukoto-detail">
                <div className="yarukoto-detail-label">出典</div>
                <div className="yarukoto-detail-text">
                  {isWebUrl(item.source) ? (
                    <a href={item.source} target="_blank" rel="noopener noreferrer">{item.source}</a>
                  ) : (
                    item.source
                  )}
                </div>
              </div>
            )}
            {!item.criteria && !item.source && (
              <div className="yarukoto-detail-empty">完了条件・出典は入っていません</div>
            )}
            {isWebUrl(item.url) && (
              <a className="yarukoto-link" href={item.url} target="_blank" rel="noopener noreferrer">Notionで開く</a>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default YarukotoItem;
