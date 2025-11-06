import 'dotenv/config';
import { db, pool } from '../server/db';
import { users } from '../shared/schema';
import { eq } from 'drizzle-orm';

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: tsx scripts/makeAdmin.ts <email>');
    process.exit(1);
  }

  try {
    console.log(`Promoting user to admin: ${email}`);

    // Update role
    await db.update(users)
      .set({ role: 'admin', updatedAt: new Date() as any })
      .where(eq(users.email, email));

    // Verify
    const rows = await db.select().from(users).where(eq(users.email, email));
    if (!rows || rows.length === 0) {
      console.error('User not found with that email.');
      process.exit(2);
    }

    const user = rows[0] as any;
    console.log('User updated:', { id: user.id, email: user.email, role: user.role, updatedAt: user.updatedAt });

    if (user.role !== 'admin') {
      console.error('Failed to set role to admin.');
      process.exit(3);
    }

    console.log('Success: user is now admin.');
  } catch (err) {
    console.error('Error updating user role:', err);
    process.exit(4);
  } finally {
    // Close PG pool if present
    try {
      if (pool && typeof pool.end === 'function') {
        await (pool as any).end();
      }
    } catch (e) {
      // ignore shutdown errors
    }
  }
}

main();
