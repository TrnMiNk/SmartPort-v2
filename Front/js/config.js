/* Runtime configuration. Only non-secret values belong here.
   apiBaseUrl is the API origin (local development default). It must match the API's SP_CORS_ORIGIN pairing:
   the API accepts credentialed requests only from the frontend origin it is configured with.
   Change this file (or serve a different one) for another environment; never put keys or passwords here. */
window.SP_CONFIG = Object.freeze({ apiBaseUrl: 'http://localhost:3000' });
