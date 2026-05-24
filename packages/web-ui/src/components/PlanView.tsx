import { useState, useEffect } from 'react';
import { getProjectPlan, addProjectTask, updateProjectTask, ProjectPlan, ProjectTask } from '../api/synapse-client';

interface PlanViewProps {
  project: string;
}

export default function PlanView({ project }: PlanViewProps) {
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New Task Form State
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (project) {
      loadPlan();
    } else {
      setPlan(null);
    }
  }, [project]);

  const loadPlan = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getProjectPlan(project);
      setPlan(data);
    } catch (err) {
      console.error('Fehler beim Laden des Plans:', err);
      setError(err instanceof Error ? err.message : String(err));
      setPlan(null);
    } finally {
      setLoading(false);
    }
  };

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;

    setSubmitting(true);
    try {
      await addProjectTask(project, title.trim(), description.trim(), priority);
      setTitle('');
      setDescription('');
      setPriority('medium');
      // Plan neu laden
      await loadPlan();
    } catch (err) {
      alert(`Fehler beim Hinzufügen der Task: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateStatus = async (taskId: string, newStatus: ProjectTask['status']) => {
    try {
      await updateProjectTask(project, taskId, { status: newStatus });
      // Plan neu laden
      await loadPlan();
    } catch (err) {
      alert(`Fehler beim Aktualisieren der Task: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (!project) {
    return (
      <div style={styles.stubView}>
        <span className="blink">AWAITING PROJECT CONTEXT FOR PLANNING DATA...</span>
      </div>
    );
  }

  const tasks = plan?.tasks || [];
  const todoTasks = tasks.filter(t => t.status === 'todo');
  const inProgressTasks = tasks.filter(t => t.status === 'in_progress');
  const doneTasks = tasks.filter(t => t.status === 'done');

  return (
    <div style={styles.container} className="animate-fade-in">
      {error && (
        <div style={styles.errorBox}>
          <span style={styles.errorTag}>PLAN ERROR</span>
          <span>{error}</span>
          <button onClick={loadPlan} className="hud-button" style={{ marginLeft: '12px', padding: '2px 8px', fontSize: '10px' }}>RETRY</button>
        </div>
      )}

      {loading && !plan ? (
        <div style={styles.loadingText} className="blink">ACCESSING DECRYPTED SECTOR PLANS...</div>
      ) : (
        <div style={styles.mainLayout}>
          {/* Plan Header Details */}
          {plan && (
            <div className="hud-panel" style={styles.planHeaderCard}>
              <div style={styles.cardHeader}>
                <span style={styles.cardTitle}>SYSTEM OPERATIONS PLAN // {plan.name.toUpperCase()}</span>
                <span style={styles.cardMeta}>UPDATED: {new Date(plan.updatedAt).toLocaleTimeString()}</span>
              </div>
              <div style={styles.cardContent}>
                <div style={styles.planDesc}>{plan.description}</div>
                {plan.goals && plan.goals.length > 0 && (
                  <div style={styles.goalsSection}>
                    <span style={styles.sectionLabel}>CRITICAL PATH OBJECTIVES:</span>
                    <ul style={styles.goalsList}>
                      {plan.goals.map((g, i) => (
                        <li key={i} style={styles.goalItem}>
                          <span style={styles.goalBullet}>[OBJ_{i.toString().padStart(2, '0')}]</span> {g}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Columns Grid */}
          <div style={styles.boardGrid}>
            {/* TODO COLUMN */}
            <div className="hud-panel" style={styles.column}>
              <div style={styles.columnHeader}>
                <span style={{ ...styles.columnTitle, color: 'var(--text-muted)' }}>01 / TO_DO</span>
                <span style={styles.columnCount}>{todoTasks.length}</span>
              </div>
              <div style={styles.columnBody}>
                {todoTasks.length === 0 ? (
                  <div style={styles.emptyColumn}>AWAITING TASKS</div>
                ) : (
                  todoTasks.map(t => (
                    <TaskCard key={t.id} task={t} onMove={(status) => handleUpdateStatus(t.id, status)} />
                  ))
                )}
              </div>
            </div>

            {/* IN PROGRESS COLUMN */}
            <div className="hud-panel" style={styles.column}>
              <div style={styles.columnHeader}>
                <span style={{ ...styles.columnTitle, color: 'var(--accent-amber)' }}>02 / IN_PROGRESS</span>
                <span style={styles.columnCount}>{inProgressTasks.length}</span>
              </div>
              <div style={styles.columnBody}>
                {inProgressTasks.length === 0 ? (
                  <div style={styles.emptyColumn}>NO ACTIVE OPERATIONS</div>
                ) : (
                  inProgressTasks.map(t => (
                    <TaskCard key={t.id} task={t} onMove={(status) => handleUpdateStatus(t.id, status)} />
                  ))
                )}
              </div>
            </div>

            {/* DONE COLUMN */}
            <div className="hud-panel" style={styles.column}>
              <div style={styles.columnHeader}>
                <span style={{ ...styles.columnTitle, color: 'var(--accent-green)' }}>03 / COMPLETED</span>
                <span style={styles.columnCount}>{doneTasks.length}</span>
              </div>
              <div style={styles.columnBody}>
                {doneTasks.length === 0 ? (
                  <div style={styles.emptyColumn}>NO COMPLETED TASKS</div>
                ) : (
                  doneTasks.map(t => (
                    <TaskCard key={t.id} task={t} onMove={(status) => handleUpdateStatus(t.id, status)} />
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Add Task Form Panel */}
          <div className="hud-panel" style={styles.formCard}>
            <div style={styles.cardHeader}>
              <span style={styles.cardTitle}>ENQUEUE NEW OPERATION TASK</span>
            </div>
            <form onSubmit={handleAddTask} style={styles.form}>
              <div style={styles.formRow}>
                <div style={{ ...styles.formGroup, flex: 2 }}>
                  <label style={styles.label}>TASK_TITLE</label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Implement Oauth flow..."
                    className="hud-input"
                    style={styles.input}
                    disabled={submitting}
                  />
                </div>
                <div style={{ ...styles.formGroup, width: '150px' }}>
                  <label style={styles.label}>PRIORITY_INDEX</label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as any)}
                    className="hud-input"
                    style={styles.select}
                    disabled={submitting}
                  >
                    <option value="low">LOW</option>
                    <option value="medium">MEDIUM</option>
                    <option value="high">HIGH</option>
                  </select>
                </div>
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>OPERATION_DETAILS / DESCRIPTION</label>
                <textarea
                  required
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Specify task instructions, requirements and context..."
                  className="hud-input"
                  style={styles.textarea}
                  disabled={submitting}
                />
              </div>
              <button type="submit" disabled={submitting} className="hud-button" style={styles.submitBtn}>
                {submitting ? 'ENQUEUING...' : 'ENQUEUE TASK'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

interface TaskCardProps {
  task: ProjectTask;
  onMove: (status: ProjectTask['status']) => void;
}

function TaskCard({ task, onMove }: TaskCardProps) {
  const isTodo = task.status === 'todo';
  const isProgress = task.status === 'in_progress';
  const isDone = task.status === 'done';

  const priorityColor =
    task.priority === 'high'
      ? 'var(--accent-red)'
      : task.priority === 'medium'
      ? 'var(--accent-amber)'
      : 'var(--accent-cyan)';

  return (
    <div style={styles.taskCard}>
      <div style={styles.taskHeader}>
        <span style={{ ...styles.taskPriority, borderColor: priorityColor, color: priorityColor }}>
          {String(task.priority || '').toUpperCase()}
        </span>
        <span style={styles.taskTime}>{new Date(task.updatedAt).toLocaleTimeString()}</span>
      </div>
      <div style={styles.taskTitle}>{typeof task.title === 'string' ? task.title : JSON.stringify(task.title)}</div>
      <div style={styles.taskDesc}>{typeof task.description === 'string' ? task.description : (task.description == null ? '' : JSON.stringify(task.description))}</div>
      <div style={styles.taskActions}>
        {isTodo && (
          <button onClick={() => onMove('in_progress')} className="hud-button" style={styles.taskActionBtn}>
            START OPERATION
          </button>
        )}
        {isProgress && (
          <>
            <button onClick={() => onMove('todo')} className="hud-button hud-button-amber" style={styles.taskActionBtn}>
              REVERT
            </button>
            <button onClick={() => onMove('done')} className="hud-button" style={{ ...styles.taskActionBtn, borderColor: 'var(--accent-green)', color: 'var(--accent-green)' }}>
              COMPLETE
            </button>
          </>
        )}
        {isDone && (
          <button onClick={() => onMove('in_progress')} className="hud-button hud-button-amber" style={styles.taskActionBtn}>
            RE-OPEN
          </button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    width: '100%',
  },
  stubView: {
    fontFamily: 'var(--font-mono)',
    fontSize: '14px',
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 'calc(100vh - 120px)',
    border: '1px dashed var(--border-color)',
  },
  loadingText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '14px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '80px 0',
  },
  errorBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    background: 'rgba(255, 59, 48, 0.1)',
    border: '1px solid var(--accent-red)',
    color: 'var(--text-bone)',
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    marginBottom: '20px',
  },
  errorTag: {
    background: 'var(--accent-red)',
    color: 'var(--bg-void)',
    padding: '2px 6px',
    fontWeight: 'bold',
  },
  mainLayout: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  planHeaderCard: {
    background: 'var(--bg-panel)',
    display: 'flex',
    flexDirection: 'column',
  },
  cardHeader: {
    padding: '12px 16px',
    background: 'var(--bg-panel-header)',
    borderBottom: '1px solid var(--border-color)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '12px',
    fontWeight: 'bold',
    color: 'var(--text-bone)',
    letterSpacing: '1px',
  },
  cardMeta: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-muted)',
  },
  cardContent: {
    padding: '16px 20px',
  },
  planDesc: {
    fontFamily: 'var(--font-ui)',
    fontSize: '15px',
    lineHeight: '1.6',
    color: 'var(--text-bone)',
    marginBottom: '16px',
  },
  goalsSection: {
    borderTop: '1px solid var(--border-color)',
    paddingTop: '12px',
  },
  sectionLabel: {
    fontFamily: 'var(--font-display)',
    fontSize: '10px',
    fontWeight: 'bold',
    color: 'var(--accent-cyan)',
    letterSpacing: '1px',
    display: 'block',
    marginBottom: '8px',
  },
  goalsList: {
    listStyleType: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  goalItem: {
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    color: 'var(--text-muted)',
    display: 'flex',
    gap: '8px',
  },
  goalBullet: {
    color: 'var(--accent-amber)',
    fontWeight: 'bold',
  },
  boardGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: '20px',
    minHeight: '350px',
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-panel)',
    height: '100%',
  },
  columnHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 14px',
    background: 'var(--bg-panel-header)',
    borderBottom: '1px solid var(--border-color)',
  },
  columnTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '12px',
    fontWeight: 'bold',
    letterSpacing: '1px',
  },
  columnCount: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    background: 'var(--bg-input)',
    padding: '2px 8px',
    border: '1px solid var(--border-color)',
    color: 'var(--text-bone)',
  },
  columnBody: {
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    flex: 1,
    overflowY: 'auto',
    maxHeight: '400px',
  },
  emptyColumn: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '40px 0',
    border: '1px dashed var(--border-color)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  formCard: {
    background: 'var(--bg-panel)',
  },
  form: {
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  formRow: {
    display: 'flex',
    gap: '16px',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: {
    fontFamily: 'var(--font-display)',
    fontSize: '10px',
    color: 'var(--text-muted)',
    fontWeight: 'bold',
    letterSpacing: '0.5px',
  },
  input: {
    width: '100%',
  },
  select: {
    width: '100%',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-bone)',
    fontFamily: 'var(--font-mono)',
    fontSize: '14px',
    padding: '10px 14px',
    outline: 'none',
    borderRadius: 0,
  },
  textarea: {
    width: '100%',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-bone)',
    fontFamily: 'var(--font-mono)',
    fontSize: '14px',
    padding: '10px 14px',
    outline: 'none',
    borderRadius: 0,
    resize: 'vertical',
  },
  submitBtn: {
    alignSelf: 'flex-start',
  },
  taskCard: {
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  taskHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  taskPriority: {
    fontFamily: 'var(--font-display)',
    fontSize: '9px',
    fontWeight: 'bold',
    border: '1px solid transparent',
    padding: '1px 6px',
    letterSpacing: '0.5px',
  },
  taskTime: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-dark)',
  },
  taskTitle: {
    fontFamily: 'var(--font-ui)',
    fontSize: '14px',
    fontWeight: 'bold',
    color: 'var(--text-bone)',
  },
  taskDesc: {
    fontFamily: 'var(--font-ui)',
    fontSize: '13px',
    color: 'var(--text-muted)',
    lineHeight: '1.4',
  },
  taskActions: {
    display: 'flex',
    gap: '8px',
    marginTop: '6px',
    borderTop: '1px solid rgba(255, 255, 255, 0.02)',
    paddingTop: '8px',
  },
  taskActionBtn: {
    padding: '4px 10px',
    fontSize: '10px',
    flex: 1,
  },
};
