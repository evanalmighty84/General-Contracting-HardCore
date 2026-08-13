const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER || 'u7muruj2vbt8hd',
  host: process.env.DB_HOST || 'cet8r1hlj0mlnt.cluster-czrs8kj4isg7.us-east-1.rds.amazonaws.com',
  database: process.env.DB_NAME || 'd76ltqhsvgublb',
  password: process.env.DB_PASSWORD || 'p86422e1e6c223a2bac5c595aa748a2d3398003bdab10653f42ffa9345c0cc556',
  port: process.env.DB_PORT || 5432,
  ssl: { rejectUnauthorized: false },
  max: 50, // Allow 50 concurrent connections
  idleTimeoutMillis: 30000, // Keep connections open for 30 seconds
  connectionTimeoutMillis: 30000, // Prevent early termination
});



pool.connect((err, client, release) => {
  if (err) {
    console.error('Error acquiring client', err.stack);
  } else {
    console.log('Successfully connected to Heroku PostgreSQL database');
  }
  release();
});

module.exports = pool;
