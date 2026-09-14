ALTER TABLE execution_steps ADD COLUMN dispatch_at TEXT;
CREATE INDEX idx_execution_steps_dispatchable ON execution_steps(queued_at) WHERE status = 'queued';
