const axios = require('axios');
async function test() {
  try {
    console.log("Starting TG login on test server...");
    // 假设测试号码为 9996621234
    // 假设 api_id 为 123456, api_hash 为 abcdef
    const res = await axios.post('http://localhost:3000/api/tg-user/start-login', {
      account_name: 'test_dev_acc',
      phone: '+9996621234',
      api_id: '123456',
      api_hash: 'abcdef1234567890abcdef1234567890'
    });
    console.log("Start Login Result:", res.data);
    
    // 如果发送成功，发送验证码 22222
    if(res.data.success) {
      console.log("Waiting 3 seconds before verifying code 22222...");
      await new Promise(r => setTimeout(r, 3000));
      const verifyRes = await axios.post('http://localhost:3000/api/tg-user/verify-code', {
        account_name: 'test_dev_acc',
        code: '22222'
      });
      console.log("Verify Code Result:", verifyRes.data);
    }
  } catch(e) {
    console.error("Error:", e.response ? e.response.data : e.message);
  }
}
test();
