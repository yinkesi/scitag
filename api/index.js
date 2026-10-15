process.env.SCITAG_SERVERLESS = '1';
const { handleCloud } = await import('../server.js');
export default { fetch: request => handleCloud(request) };
