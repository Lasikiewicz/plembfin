import fetch from 'node-fetch';

async function main() {
  const token = 'e34f8be453ac9f1cdf0d2af6a174a93b8a6a17a5c7ed3690';
  const url = 'http://127.0.0.1:5055/api/tmdb-search?query=tom%20hanks&mediaType=multi';
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    console.log('Status:', res.status);
    const body = await res.json();
    console.log('Total Results:', body.results?.length);
    if (body.results) {
      body.results.forEach((item, index) => {
        console.log(`[${index}] media_type: ${item.media_type}, name/title: ${item.name || item.title}, id: ${item.id}`);
      });
    }
  } catch (e) {
    console.error('API call failed:', e);
  }
}

main();
