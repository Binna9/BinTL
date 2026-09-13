DROP TRIGGER IF EXISTS trg_execution_step_status;
CREATE TRIGGER trg_execution_step_status
AFTER UPDATE OF status ON execution_steps
BEGIN
    UPDATE executions
    SET status = CASE
            WHEN EXISTS (SELECT 1 FROM execution_steps WHERE execution_id = NEW.execution_id AND status = 'failed') THEN 'failed'
            WHEN EXISTS (SELECT 1 FROM execution_steps WHERE execution_id = NEW.execution_id AND status = 'running') THEN 'running'
            WHEN NOT EXISTS (SELECT 1 FROM execution_steps WHERE execution_id = NEW.execution_id AND status IN ('queued', 'running')) THEN 'succeeded'
            ELSE 'queued'
        END,
        started_at = CASE WHEN NEW.status = 'running' THEN COALESCE(started_at, NEW.started_at) ELSE started_at END,
        finished_at = CASE WHEN NEW.status IN ('succeeded', 'failed', 'canceled') THEN NEW.finished_at ELSE finished_at END,
        error_message = CASE WHEN NEW.status = 'failed' THEN NEW.error_message ELSE error_message END
    WHERE id = NEW.execution_id AND source != 'workspace';
END;

CREATE INDEX idx_executions_workspace_source ON executions(workspace_id, source, created_at DESC);
