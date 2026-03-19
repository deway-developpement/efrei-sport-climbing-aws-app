export default {
    transform: {
        '^.+\\.ts?$': 'esbuild-jest',
    },
    moduleNameMapper: {
        '^commons/(.*)$': '<rootDir>/../../layers/commons/$1',
    },
    clearMocks: true,
    collectCoverage: true,
    coverageDirectory: 'coverage',
    coverageProvider: 'v8',
    testMatch: ['**/tests/unit/*.test.ts'],
};
