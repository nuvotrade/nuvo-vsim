// These hashes version the exact model-bearing files for each Underwrite surface.
// The matching test recomputes every component and the aggregate; any model-file
// change must produce a new surface hash and therefore a fresh calibration n.
export const UNDERWRITE_SURFACE_MODEL_LOCKS = Object.freeze({
  CSP_SINGLE_TICKER: Object.freeze({
    label: 'CSP_PRIMARY_CENTERED_5_DAY_BOOTSTRAP',
    hash: '53ffab7835da0b87fa72514698e09622dd351474b41892f339e30c7cd4acc5e8',
    components: Object.freeze({
      'cloudflare/cash-secured-put-calculator.js': 'a3e6d7dfb2d2b604dee18a2610758de7da0b864ccbda8916c09a2731030dbfd8',
      'cloudflare/underwrite-model-engine.js': '3e5e720b9e39339023b9290576dce515bb8f05fc8967f41e4bd45522663ed9e0',
      'src/math/distribution.js': '43b9affd8005948ec5dcb8cac770e5720ce6f7c05e7a4829d24e14dd385564f9',
      'src/math/stats.js': '5bc3bbda0645eb6353bd76658e71d1cfe81f0e47838f5a6720bbe54795b59275',
    }),
  }),
  COVERED_CALL_SINGLE_TICKER: Object.freeze({
    label: 'CC_PRIMARY_CENTERED_5_DAY_BOOTSTRAP',
    hash: '8019af1eefb2aad2047b0886619b8d63c62c23cff0926e4fdb4b4e9142ad2bb5',
    components: Object.freeze({
      'cloudflare/covered-call-calculator.js': '0640f5290e741d602deb1c24f633abf1863e04b7cf9640e6e6ee7a92c25f13e3',
      'cloudflare/underwrite-model-engine.js': '3e5e720b9e39339023b9290576dce515bb8f05fc8967f41e4bd45522663ed9e0',
      'src/math/distribution.js': '43b9affd8005948ec5dcb8cac770e5720ce6f7c05e7a4829d24e14dd385564f9',
      'src/math/stats.js': '5bc3bbda0645eb6353bd76658e71d1cfe81f0e47838f5a6720bbe54795b59275',
    }),
  }),
  PORTFOLIO_REVIEW: Object.freeze({
    label: 'PORTFOLIO_REVIEW_PRIMARY_CENTERED_5_DAY_BOOTSTRAP',
    hash: 'cb60d3ae00a9c086343c8a4bf9000e10b6829175a1dd46be204c1ec6b6a809b6',
    components: Object.freeze({
      'cloudflare/portfolio-review.js': '1acbba01bd2407af48be2f70910a8219839011133266d9d08144b8b27507cf24',
      'cloudflare/cash-secured-put-calculator.js': 'a3e6d7dfb2d2b604dee18a2610758de7da0b864ccbda8916c09a2731030dbfd8',
      'cloudflare/underwrite-model-engine.js': '3e5e720b9e39339023b9290576dce515bb8f05fc8967f41e4bd45522663ed9e0',
      'src/math/distribution.js': '43b9affd8005948ec5dcb8cac770e5720ce6f7c05e7a4829d24e14dd385564f9',
      'src/math/stats.js': '5bc3bbda0645eb6353bd76658e71d1cfe81f0e47838f5a6720bbe54795b59275',
    }),
  }),
});

export function underwriteSurfaceModelLock(surface) {
  return UNDERWRITE_SURFACE_MODEL_LOCKS[surface]
    ?? UNDERWRITE_SURFACE_MODEL_LOCKS.PORTFOLIO_REVIEW;
}
