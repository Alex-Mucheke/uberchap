import {
  Body, Controller, ForbiddenException, Get, Headers, HttpCode, NotFoundException, NotImplementedException,
  Param, ParseUUIDPipe, Post, ConflictException, BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { timingSafeEqual, randomBytes } from 'crypto';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthUser, CurrentUser, Public, Roles } from '../common/decorators';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

class CashPaymentDto {
  @IsUUID() bookingId: string;
  /** Optional tip received in cash, whole KES. The service charge always comes from the booking. */
  @IsOptional() @IsInt() @Min(0) @Max(100_000) tip?: number;
}

function receiptNumber() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `TDN-${d}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

@Controller('payments')
export class PaymentsController {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  /**
   * Pilot: the assigned driver records a CASH payment after the trip is completed.
   * Amounts are derived from the booking on the server; clients cannot set the service charge.
   * One payment per booking (unique bookingId) makes this idempotent.
   */
  @Roles('DRIVER')
  @Post('cash')
  async recordCash(@CurrentUser() user: AuthUser, @Body() dto: CashPaymentDto) {
    const b = await this.prisma.booking.findUnique({ where: { id: dto.bookingId } });
    if (!b) throw new NotFoundException('Booking not found');
    if (b.assignedDriverId !== user.id) throw new ForbiddenException();
    if (b.state !== 'COMPLETED') throw new BadRequestException('Payment can only be recorded for a completed booking');

    const tip = dto.tip ?? 0;
    try {
      const p = await this.prisma.payment.create({
        data: {
          bookingId: b.id, method: 'CASH', state: 'PAID',
          serviceCharge: b.quote, itemCost: 0, platformFee: 0, tip,
          total: b.quote + tip,
          receiptNumber: receiptNumber(), paidAt: new Date(),
        },
      });
      await this.prisma.bookingEvent.create({ data: { bookingId: b.id, type: 'PAYMENT_RECORDED', actorId: user.id, metadata: { paymentId: p.id, method: 'CASH', total: p.total } } });
      await this.notifications.notify(b.customerId, 'PAYMENT_RECORDED', 'Receipt available', `Cash payment of KES ${p.total} recorded.`, { bookingId: b.id });
      return p;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A payment is already recorded for this booking');
      }
      throw e;
    }
  }

  @Get('booking/:bookingId')
  async forBooking(@CurrentUser() user: AuthUser, @Param('bookingId', ParseUUIDPipe) bookingId: string) {
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId }, include: { payment: true } });
    if (!b) throw new NotFoundException();
    if (b.customerId !== user.id && b.assignedDriverId !== user.id) throw new ForbiddenException();
    return b.payment;
  }

  /** M-Pesa STK initiation arrives in Phase 8 (after the booking workflow has proven reliable). */
  @Roles('CUSTOMER')
  @Post('mpesa/initiate')
  initiate(): never {
    throw new NotImplementedException('M-Pesa payments are not enabled in this release. Use cash for the pilot.');
  }

  /**
   * Daraja STK callback. Authenticated with a shared secret header (configure your edge/proxy to add it),
   * idempotent on CheckoutRequestID, and never driven by a client-side success message.
   */
  @Public()
  @SkipThrottle()
  @HttpCode(200)
  @Post('mpesa/callback')
  async mpesaCallback(@Headers('x-callback-secret') secret: string | undefined, @Body() body: any) {
    const expected = process.env.MPESA_CALLBACK_SECRET;
    if (!expected || !secret || !safeEqual(secret, expected)) throw new ForbiddenException();

    const cb = body?.Body?.stkCallback;
    const ref: string | undefined = cb?.CheckoutRequestID;
    if (!ref) throw new BadRequestException('Malformed callback');

    const payment = await this.prisma.payment.findUnique({ where: { providerReference: ref } });
    // Always ACK so the provider stops retrying; unknown refs are recorded nowhere but are not an error.
    if (!payment) return { ResultCode: 0, ResultDesc: 'Accepted' };

    const ok = cb.ResultCode === 0;
    // Guarded update: duplicate callbacks cannot move a payment out of a final state.
    const res = await this.prisma.payment.updateMany({
      where: { id: payment.id, state: 'PENDING' },
      data: {
        state: ok ? 'PAID' : 'FAILED',
        paidAt: ok ? new Date() : null,
        receiptNumber: ok ? receiptNumber() : null,
        rawCallback: body as Prisma.InputJsonValue,
      },
    });
    if (res.count === 1) {
      await this.prisma.bookingEvent.create({
        data: { bookingId: payment.bookingId, type: ok ? 'PAYMENT_CONFIRMED' : 'PAYMENT_FAILED', actorId: null, metadata: { paymentId: payment.id, provider: 'MPESA' } },
      });
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }
}
