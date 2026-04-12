module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/client/src'],
  testMatch: ['**/__tests__/**/*.test.{js,jsx}'],
  transform: {
    '\\.[jt]sx?$': ['babel-jest', {
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        ['@babel/preset-react', { runtime: 'automatic' }],
      ],
    }],
  },
  moduleNameMapper: {
    '\\.(css|less|scss)$': 'identity-obj-proxy',
    '\\.(svg|png|jpg|gif)$': '<rootDir>/client/src/__mocks__/fileMock.js',
    '^@server-config/(.*)$': '<rootDir>/server/config/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/client/src/__mocks__/setup.js'],
  clearMocks: true,
};
