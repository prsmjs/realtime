export default {
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    include: ["tests/**/*.test.js"],
    reporters: ["verbose"],
    testTimeout: 15000,
  },
}
