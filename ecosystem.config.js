module.exports = {
  apps : [{
    name: 'API',
    script: 'dist/index.js',
    // Run the app on Node 16 while leaving the pm2 daemon on the system Node 9.
    // The OS caps us here: Ubuntu 16.04 ships glibc 2.23, and Node 18/20/22 all
    // refuse to start on it (verified on the host). Node 16 is EOL too, but it
    // trades ~8 years of unpatched runtime CVEs for ~3. See NODE-UPGRADE.md.
    // Rollback: delete this line and reload.
    interpreter: '/home/billy/node/bin/node',
    env: {
      NODE_ENV: 'development',
      DEBUG: 'app:*',
      SYNC_TOKEN: 'ruby-tuesday'
    },
    env_production : {
      NODE_ENV: 'production',
      DEBUG: 'app:*',
      SYNC_TOKEN: 'outback-steakhouse'
    }
  }]
}
