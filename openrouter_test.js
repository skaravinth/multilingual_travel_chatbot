require('dotenv').config();
const axios = require('axios');
(async () => {
  try {
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'deepseek/deepseek-chat',
      messages: [{ role: 'system', content: 'Hello' }],
      temperature: 0.7
    }, {
      headers: {
        Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    console.log('SUCCESS', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('ERROR MESSAGE', error.message);
    if (error.response) {
      console.error('STATUS', error.response.status);
      console.error('DATA', JSON.stringify(error.response.data, null, 2));
    }
  }
})();
