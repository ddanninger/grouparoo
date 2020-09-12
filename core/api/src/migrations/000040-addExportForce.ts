module.exports = {
  up: async function (migration, DataTypes) {
    await migration.addColumn("exports", "force", {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: true,
    });

    await migration.changeColumn("exports", "force", {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    });
  },

  down: async function (migration) {
    await migration.removeColumn("exports", "force");
  },
};