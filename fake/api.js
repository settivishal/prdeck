const API_KEY = "sk-live-0123456789abcdef";
const { exec } = require("child_process");
function run(cmd) { exec("ls " + cmd); }
function find(db, id) { return db.query("SELECT * FROM users WHERE id = " + id); }
const res = fetch("http://api.example.com/v1");
eval(process.argv[2]);
