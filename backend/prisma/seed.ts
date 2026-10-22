import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function user(name: string, email: string, phone: string, roles: ('CUSTOMER' | 'DRIVER' | 'ADMIN')[], password: string) {
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: { name, email, phone, roles, passwordHash: await bcrypt.hash(password, 12) },
  });
}

async function verifiedDriver(u: { id: string }, shareCode: string, plate: string, make: string, model: string) {
  await prisma.driverProfile.upsert({
    where: { userId: u.id },
    update: {},
    create: {
      userId: u.id, shareCode, verificationStatus: 'APPROVED', availability: 'ONLINE', serviceArea: 'Chuka Town',
      bio: 'Demo driver (seed data).',
      services: { create: [{ serviceType: 'RIDE', active: true }] },
      vehicles: { create: [{ plate, type: 'SEDAN', make, model, color: 'White', capacity: 4 }] },
    },
  });
}

async function main() {
  await user('Platform Admin', process.env.ADMIN_EMAIL ?? 'admin@example.com', '+254700000000', ['ADMIN'], process.env.ADMIN_PASSWORD ?? 'ChangeMe123!');

  if (process.env.SEED_DEMO !== 'true') return;

  // Demo data to exercise the golden flow locally: customer -> driver A (busy) -> trusted peer B.
  const pw = 'Password123!';
  const customer = await user('Demo Customer', 'customer@example.com', '+254711000001', ['CUSTOMER'], pw);
  const a = await user('Driver Alice', 'alice@example.com', '+254711000002', ['DRIVER'], pw);
  const b = await user('Driver Bob', 'bob@example.com', '+254711000003', ['DRIVER'], pw);
  await verifiedDriver(a, 'ALICE234', 'KDA 100A', 'Toyota', 'Axio');
  await verifiedDriver(b, 'BOB23456', 'KDB 200B', 'Toyota', 'Premio');

  await prisma.customerDriverConnection.upsert({
    where: { customerId_driverId: { customerId: customer.id, driverId: a.id } },
    update: {},
    create: { customerId: customer.id, driverId: a.id, status: 'ACTIVE' },
  });
  const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  await prisma.driverConnection.upsert({
    where: { driverAId_driverBId: { driverAId: x, driverBId: y } },
    update: {},
    create: { driverAId: x, driverBId: y, requestedBy: a.id, trustStatus: 'TRUSTED' },
  });

  // eslint-disable-next-line no-console
  console.log('Seeded. Demo logins (password Password123!): customer@example.com, alice@example.com, bob@example.com');
}

main().finally(() => prisma.$disconnect());
