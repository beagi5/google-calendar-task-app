import React from 'react';

const REPEAT_LABELS = {
  daily: '毎日',
  weekly: '毎週',
  monthly: '毎月',
};

const CATEGORY_BADGE_CLASS = {
  'YCDC': 'category-badge-ycdc',
  '事業': 'category-badge-business',
  '株': 'category-badge-stock',
  'マネジメント': 'category-badge-management',
  'その他': 'category-badge-other',
};

const CategoryBadge = ({ category }) => {
  if (!category) return null;
  return (
    <span className={`category-badge ${CATEGORY_BADGE_CLASS[category] || ''}`}>{category}</span>
  );
};

// 'YYYY-MM-DD...' -> 'M/D'
const formatDueDate = (dueDate) => {
  const [, m, d] = dueDate.split('T')[0].split('-');
  return `${Number(m)}/${Number(d)}`;
};

const TaskItem = ({
  task,
  currentUserId,
  onToggleComplete,
  onEdit,
  onDelete,
  onCarryOver,
  compact = false,
  overdue = false,
  parentTitle = null,
}) => {
  const isOwner = task.userId === currentUserId;
  const itemClass = [
    compact ? 'task-item-compact' : 'task-item',
    task.completed ? 'completed' : '',
    overdue && !task.completed ? 'overdue' : '',
  ].filter(Boolean).join(' ');

  if (compact) {
    return (
      <div className={itemClass}>
        <input
          type="checkbox"
          checked={!!task.completed}
          disabled={!isOwner}
          onChange={() => onToggleComplete(task)}
        />
        <span className="task-item-title">
          {task.title}
          {task.repeat && task.repeat !== 'none' && ` (くり返し: ${REPEAT_LABELS[task.repeat]})`}
        </span>
        <CategoryBadge category={task.category} />
        <span style={{ fontSize: '12px', color: '#666' }}>進捗: {task.progress}%</span>
        {overdue && !task.completed && <span className="overdue-badge">期限切れ</span>}
        {isOwner && (
          <div className="task-actions">
            <button type="button" onClick={() => onEdit(task)}>編集</button>
            <button type="button" onClick={() => onDelete(task)}>削除</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={itemClass}>
      <div className="task-item-header">
        <input
          type="checkbox"
          checked={!!task.completed}
          disabled={!isOwner}
          onChange={() => onToggleComplete(task)}
        />
        <div className="task-item-body">
          <div className="task-item-title" style={{ fontWeight: 600, fontSize: '16px', color: '#333' }}>
            {task.title}
            <CategoryBadge category={task.category} />
            {overdue && !task.completed && (
              <span className="overdue-badge">期限切れ{task.dueDate ? `(${formatDueDate(task.dueDate)})` : ''}</span>
            )}
          </div>
          {task.description && (
            <div style={{ color: '#666', fontSize: '14px', margin: '8px 0' }}>{task.description}</div>
          )}
          {parentTitle && <div className="task-parent-hint">親: {parentTitle}</div>}
          {task.repeat && task.repeat !== 'none' && (
            <div className="task-parent-hint">くり返し: {REPEAT_LABELS[task.repeat]}</div>
          )}
          {isOwner && (
            <div className="task-actions">
              <button type="button" onClick={() => onEdit(task)}>編集</button>
              <button type="button" onClick={() => onDelete(task)}>削除</button>
              {onCarryOver && <button type="button" className="carry-over-btn" onClick={() => onCarryOver(task)}>今日に移す</button>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TaskItem;
