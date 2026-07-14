module.exports = {
  apps: [
    {
      // Persistent LibreOffice daemon for fast DOCX → PDF conversion.
      // First conversion warms the daemon (~30s), every subsequent
      // conversion via `unoconvert --port 2003` is ~0.4s.
      name: 'unoserver',
      script: '/usr/local/bin/unoserver',
      args: '--port 2003 --interface 127.0.0.1',
      interpreter: 'none',
      env: { PYTHONUNBUFFERED: '1' },
      max_memory_restart: '1G',
      autorestart: true,
      kill_timeout: 5000,
    },
    {
      name: 'tailorresume-v2',
      cwd: '/var/@TailorResume/backend',
      script: '.venv/bin/python',
      // 1 worker only: the live-board WebSocket hub (core/hub.py) keeps its connection registry
      // in process memory with no cross-process fan-out. With >1 worker, a broadcast triggered on
      // one worker never reaches a socket held by another -- roughly half of connected clients
      // silently stop seeing live updates.
      args: '-m uvicorn main:app --host 0.0.0.0 --port 8503 --workers 1',
      interpreter: 'none',
      env: {
        PYTHONUNBUFFERED: '1',
      },
      max_memory_restart: '1G',
      autorestart: true,
    },
    {
      // Pulls approved jobs from Resume-Generator-v2 (remote PostgreSQL)
      // every 20 minutes and inserts new ones into the local SQLite.
      name: 'job-sync',
      cwd: '/var/@TailorResume/backend',
      script: '.venv/bin/python',
      args: 'core/job_sync.py',
      interpreter: 'none',
      env: {
        PYTHONUNBUFFERED: '1',
      },
      max_memory_restart: '256M',
      autorestart: true,
      restart_delay: 5000,
    },
  ],
};
