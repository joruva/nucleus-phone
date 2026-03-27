require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');
const { initSchema } = require('./db');
const { errorHandler } = require('./middleware/error');
const { apiKeyAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? 'https://nucleus-phone.onrender.com'
    : true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'nucleus-phone', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/token', apiKeyAuth, require('./routes/token'));
app.use('/api/voice', require('./routes/voice'));
app.use('/api/call', require('./routes/call'));
app.use('/api/call/recording-status', require('./routes/recording'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/history', require('./routes/history'));

// Serve React build in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.use(errorHandler);

async function start() {
  await initSchema();
  app.listen(PORT, () => {
    console.log(`nucleus-phone listening on :${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
