module.exports = {
  apps : [{
    name: 'API',
    script: 'dist/index.js',
    env: {
      NODE_ENV: 'development',
      DEBUG: 'app:*'
    },
    env_production : {
      NODE_ENV: 'production',
      DEBUG: false
    }
  }]
}
