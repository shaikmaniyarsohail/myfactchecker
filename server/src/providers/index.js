import wikipedia from './wikipedia.js';
import duckduckgo from './duckduckgo.js';
import googleFactcheck from './google-factcheck.js';
import googleNews from './google-news.js';

export const providers = [googleFactcheck, wikipedia, duckduckgo, googleNews];
export { wikipedia, duckduckgo, googleFactcheck, googleNews };
