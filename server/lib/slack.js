const { formatDuration } = require('./format');

async function sendSlackAlert(message) {
  const webhookUrl = process.env.SLACK_SALES_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('SLACK_SALES_WEBHOOK_URL not set — skipping alert');
    return false;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!res.ok) {
      console.error('Slack alert failed:', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Slack alert error:', err.message);
    return false;
  }
}

function formatCallAlert(callData) {
  const emoji = callData.qualification === 'hot' ? ':fire:' : ':thermometer:';
  return {
    text: `${emoji} *${callData.disposition}* — ${callData.leadName} at ${callData.leadCompany}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${emoji === ':fire:' ? '🔥' : '🌡️'} ${callData.qualification?.toUpperCase() || 'QUALIFIED'} Lead — Phone Call` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Contact:*\n${callData.leadName}` },
          { type: 'mrkdwn', text: `*Company:*\n${callData.leadCompany}` },
          { type: 'mrkdwn', text: `*Called by:*\n${callData.callerIdentity}` },
          { type: 'mrkdwn', text: `*Duration:*\n${formatDuration(callData.durationSeconds)}` },
        ],
      },
      ...(callData.notes ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Notes:*\n${callData.notes}` },
      }] : []),
      ...(callData.productsDiscussed?.length ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Products:*\n${callData.productsDiscussed.join(', ')}` },
      }] : []),
    ],
  };
}

module.exports = { sendSlackAlert, formatCallAlert };
