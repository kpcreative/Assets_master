const https = require('https');

const CLIENT_ID = 'de8bc8b5-d9f9-48b1-a8ad-b748da725064';
const SCOPE = 'https://graph.microsoft.com/Mail.Send offline_access';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'login.microsoftonline.com',
      path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const dc = await post(
    '/common/oauth2/v2.0/devicecode',
    `client_id=${CLIENT_ID}&scope=${encodeURIComponent(SCOPE)}`
  );

 console.log('\nFull response:', JSON.stringify(dc, null, 2));


  console.log('\nWaiting for you to sign in...');

  let tokens;
  while (!tokens?.access_token) {
    await new Promise(r => setTimeout(r, 5000));
    tokens = await post(
      '/common/oauth2/v2.0/token',
      `client_id=${CLIENT_ID}&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${dc.device_code}`
    );
  }

  console.log('\n✅ SUCCESS! Copy this command:\n');
  console.log(`cf set-env <your-app-name> GRAPH_REFRESH_TOKEN "${tokens.refresh_token}"`);
}

main().catch(console.error);
