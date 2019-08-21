module.exports = {
  apps : [{
    name: 'API',
    script: 'dist/index.js',
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
