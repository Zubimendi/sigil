module.exports = {
  rootDir: '../../',
  testEnvironment: 'node',
  roots: ['<rootDir>/apps/collector/src', '<rootDir>/apps/collector/test'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
};
