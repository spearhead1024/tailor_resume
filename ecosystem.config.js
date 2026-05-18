module.exports = {
  apps: [
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
