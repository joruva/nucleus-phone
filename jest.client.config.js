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
    // Pin React to the root copy. `client/node_modules/react` exists alongside
    // `node_modules/react` (from the workspace install), and jest's resolver
    // picks the closer one for components but the farther one for
    // @testing-library/react. That hook-dispatcher mismatch shows up as
    // "Cannot read properties of null (reading 'useEffect')" in tests.
    '^react$': '<rootDir>/node_modules/react',
    '^react-dom$': '<rootDir>/node_modules/react-dom',
    '^react/jsx-runtime$': '<rootDir>/node_modules/react/jsx-runtime',
    '^react/jsx-dev-runtime$': '<rootDir>/node_modules/react/jsx-dev-runtime',
  },
  setupFilesAfterEnv: ['<rootDir>/client/src/__mocks__/setup.js'],
  clearMocks: true,
};
