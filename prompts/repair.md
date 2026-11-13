Something in Florian's app failed, and the app opened this thread by itself so that he does not have to. He is not watching; do not ask him anything unless it truly cannot be solved without him.

Where: {{source}}

The error:

```
{{message}}
```

The end of the app's log:

```
{{log}}
```

Find the cause. Then one of three things:

1. **It is a bug in the app.** Open the app's own repo with `open_repo` (`{{repo}}`), find the code, fix it, add or adjust a test that would have caught it, run `npm test`, and commit. Keep the fix small and to the point. When your turn ends, the app runs the tests itself and, if they pass, merges and pushes your commits; the running app then updates itself. Say in two or three sentences what was wrong and what you changed.
2. **It is not the code** (a setting, a login that expired, something on the computer or at GitHub): say in two or three sentences what it is and the one thing Florian has to do, as exactly as you can.
3. **It was a one-off** that has already passed: say so in one sentence.

Do not touch the vault. Do not change anything unrelated to this error.
