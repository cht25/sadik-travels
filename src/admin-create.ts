import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { createStore } from './store.js';
import { hashPassword, normalizeIdentity } from './security.js';

const rl = readline.createInterface({ input, output });
rl.question('Super admin email: ', emailInput => {
  rl.question('Super admin password: ', async password => {
    try {
      const { identity, channel } = normalizeIdentity(emailInput.trim());
      if (channel !== 'email') throw new Error('Super admin bootstrap requires an email address');
      const store = createStore().store;
      let user = await store.findUserByIdentity(identity);
      if (!user) user = await store.createUser({ identity, channel, role: 'super_admin' });
      else await store.setUserRole(user.id, 'super_admin');
      await store.setPasswordHash(user.id, await hashPassword(password));
      console.log(`Super admin ready: ${identity}`);
      store.close();
    } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
    finally { rl.close(); }
  });
});
