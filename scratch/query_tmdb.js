import { loadMediaConfig } from '../server/src/utils/configStore.js';
import { searchTmdb } from '../server/src/utils/tmdbGateway.js';

async function main() {
  try {
    const config = await loadMediaConfig();
    console.log('TMDB Configured:', config.tmdb?.configured);
    console.log('TMDB API Key prefix:', config.tmdb?.apiKey ? config.tmdb.apiKey.slice(0, 5) + '...' : 'none');

    const result = await searchTmdb({ query: 'tom hanks', mediaType: 'multi' });
    console.log('Search Results count:', result.results?.length);
    if (result.results) {
      result.results.forEach((item, index) => {
        console.log(`[${index}] media_type: ${item.media_type}, name/title: ${item.name || item.title}, id: ${item.id}`);
        if (item.known_for) {
          console.log(`    Known for:`, item.known_for.map(k => `${k.media_type}: ${k.title || k.name}`).join(', '));
        }
      });
    }
  } catch (e) {
    console.error('Error running search:', e);
  }
}

main();
