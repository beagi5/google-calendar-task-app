import React, { useState } from 'react';
import axios from 'axios';

axios.defaults.withCredentials = true;

const TaskForm = ({ onTaskCreated, onClose, tasks }) => {
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    level: 'daily',
    parentId: '',
    dueDate: ''
  });

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const response = await axios.post('http://localhost:3001/api/tasks', formData);
      onTaskCreated(response.data);
      setFormData({
        title: '',
        description: '',
        level: 'daily',
        parentId: '',
        dueDate: ''
      });
      onClose();
    } catch (error) {
      console.error('Error creating task:', error);
      alert('タスクの作成に失敗しました');
    }

    setIsSubmitting(false);
  };

  const getParentOptions = () => {
    if (!tasks) return [];
    
    switch (formData.level) {
      case 'quarterly':
        return tasks.yearly || [];
      case 'monthly':
        return tasks.quarterly || [];
      case 'weekly':
        return tasks.monthly || [];
      case 'daily':
        return tasks.weekly || [];
      default:
        return [];
    }
  };

  const parentOptions = getParentOptions();

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        backgroundColor: 'white',
        padding: '30px',
        borderRadius: '10px',
        width: '500px',
        maxWidth: '90vw',
        maxHeight: '80vh',
        overflowY: 'auto'
      }}>
        <h2>新しいタスクを作成</h2>
        
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
              タスクのレベル
            </label>
            <select
              name="level"
              value={formData.level}
              onChange={handleInputChange}
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                fontSize: '14px'
              }}
              required
            >
              <option value="yearly">📅 年間目標</option>
              <option value="quarterly">📊 四半期目標</option>
              <option value="monthly">📅 月間タスク</option>
              <option value="weekly">📝 週間タスク</option>
              <option value="daily">✅ 日次タスク</option>
            </select>
          </div>

          {parentOptions.length > 0 && (
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                上位目標
              </label>
              <select
                name="parentId"
                value={formData.parentId}
                onChange={handleInputChange}
                style={{
                  width: '100%',
                  padding: '8px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px'
                }}
              >
                <option value="">選択してください</option>
                {parentOptions.map(parent => (
                  <option key={parent.id} value={parent.id}>
                    {parent.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
              タスク名
            </label>
            <input
              type="text"
              name="title"
              value={formData.title}
              onChange={handleInputChange}
              placeholder="タスクのタイトルを入力"
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                fontSize: '14px'
              }}
              required
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
              説明
            </label>
            <textarea
              name="description"
              value={formData.description}
              onChange={handleInputChange}
              placeholder="タスクの詳細説明"
              rows="3"
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                fontSize: '14px',
                resize: 'vertical'
              }}
            />
          </div>

          {(formData.level === 'daily' || formData.level === 'weekly') && (
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                締切日
              </label>
              <input
                type="date"
                name="dueDate"
                value={formData.dueDate}
                onChange={handleInputChange}
                style={{
                  width: '100%',
                  padding: '8px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px'
                }}
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '10px 20px',
                border: '1px solid #ddd',
                borderRadius: '5px',
                backgroundColor: 'white',
                cursor: 'pointer'
              }}
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                padding: '10px 20px',
                border: 'none',
                borderRadius: '5px',
                backgroundColor: '#4285f4',
                color: 'white',
                cursor: isSubmitting ? 'not-allowed' : 'pointer'
              }}
            >
              {isSubmitting ? '作成中...' : 'タスクを作成'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default TaskForm;