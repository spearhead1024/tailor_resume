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
      args: '-m uvicorn main:app --host 0.0.0.0 --port 8503 --workers 2',
      interpreter: 'none',
      env: {
        PYTHONUNBUFFERED: '1',
      },
      max_memory_restart: '1G',
      autorestart: true,
    },
  ],
};
