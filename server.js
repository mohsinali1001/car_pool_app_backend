require('dotenv').config();
const app = require('./src/app');

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
  console.log(`CarPool backend running on port ${PORT}`);
});
