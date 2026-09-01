import React from 'react';

const REPEAT_LABELS = {
  daily: '毎日',
  weekly: '毎週',
  monthly: '毎月',
};

const TaskItem = ({
  task,
  currentUserId,
  onToggleComplete,
  onEdit,
  onDelete,
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
            {overdue && !task.completed && <span className="overdue-badge">期限切れ</span>}
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TaskItem;
