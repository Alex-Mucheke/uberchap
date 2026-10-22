import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Prisma, ReportStatus } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

class VerifyDto {
  @IsIn(['APPROVED', 'REJECTED']) decision: 'APPROVED' | 'REJECTED';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class UserStatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED']) status: 'ACTIVE' | 'SUSPENDED';
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class ReportUpdateDto {
  @IsEnum(ReportStatus) status: ReportStatus;
  @IsOptional() @IsString() @MaxLength(2000) resolutionNote?: string;
}

@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  private audit(adminId: string, action: string, entityType: string, entityId: string, metadata?: Record<string, unknown>) {
    return this.prisma.adminAuditLog.create({
      data: { adminId, action, entityType, entityId, metadata: metadata as Prisma.InputJsonValue | undefined },
    });
  }

  // ---------------- verification queue ----------------

  @Get('verification')
  queue() {
    return this.prisma.driverProfile.findMany({
      where: { verificationStatus: 'PENDING' },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true, createdAt: true } },
        vehicles: true,
        documents: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Post('verification/:driverId')
  async verify(@CurrentUser() admin: AuthUser, @Param('driverId', ParseUUIDPipe) driverId: string, @Body() dto: VerifyDto) {
    const p = await this.prisma.driverProfile.findUnique({ where: { userId: driverId }, include: { documents: true, vehicles: true } });
    if (!p) throw new NotFoundException('Driver not found');
    if (dto.decision === 'APPROVED') {
      if (p.documents.length === 0) throw new BadRequestException('No documents submitted');
      if (p.vehicles.filter((v) => v.active).length === 0) throw new BadRequestException('Driver has no active vehicle');
    }
    await this.prisma.$transaction([
      this.prisma.driverProfile.update({
        where: { userId: driverId },
        data: {
          verificationStatus: dto.decision, verificationNote: dto.note ?? null,
          ...(dto.decision === 'REJECTED' ? { availability: 'OFFLINE' } : {}),
        },
      }),
      this.prisma.verificationDocument.updateMany({
        where: { driverId, status: 'PENDING' },
        data: { status: dto.decision, reviewedById: admin.id, reviewNote: dto.note ?? null },
      }),
    ]);
    await this.audit(admin.id, `DRIVER_${dto.decision}`, 'DriverProfile', driverId, { note: dto.note });
    await this.notifications.notify(
      driverId, 'VERIFICATION', dto.decision === 'APPROVED' ? 'You are verified' : 'Verification needs attention',
      dto.decision === 'APPROVED' ? 'You can now go online and receive bookings.' : dto.note ?? 'Please review your documents and resubmit.',
    );
    return { ok: true };
  }

  // ---------------- users ----------------

  @Get('users')
  users(@Query('q') q?: string) {
    return this.prisma.user.findMany({
      where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] } : {},
      select: { id: true, name: true, email: true, phone: true, roles: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Patch('users/:id/status')
  async setStatus(@CurrentUser() admin: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UserStatusDto) {
    if (id === admin.id) throw new BadRequestException('You cannot change your own status');
    const u = await this.prisma.user.update({ where: { id }, data: { status: dto.status }, select: { id: true, status: true } });
    if (dto.status === 'SUSPENDED') {
      await this.prisma.driverProfile.updateMany({ where: { userId: id }, data: { availability: 'OFFLINE' } });
    }
    await this.audit(admin.id, `USER_${dto.status}`, 'User', id, { reason: dto.reason });
    return u;
  }

  // ---------------- oversight ----------------

  @Get('bookings')
  bookings(@Query('state') state?: string) {
    return this.prisma.booking.findMany({
      where: state ? { state: state as any } : {},
      include: {
        customer: { select: { id: true, name: true } },
        requestedDriver: { select: { id: true, name: true } },
        assignedDriver: { select: { id: true, name: true } },
        rideDetails: true,
        payment: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Get('bookings/:id/events')
  events(@Param('id', ParseUUIDPipe) id: string) {
    return this.prisma.bookingEvent.findMany({ where: { bookingId: id }, orderBy: { createdAt: 'asc' } });
  }

  @Get('referrals')
  referrals() {
    return this.prisma.referral.findMany({
      include: { proposer: { select: { id: true, name: true } }, candidate: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Get('reports')
  reports(@Query('status') status?: string) {
    return this.prisma.report.findMany({
      where: status ? { status: status as ReportStatus } : {},
      include: {
        reporter: { select: { id: true, name: true } },
        target: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Patch('reports/:id')
  async updateReport(@CurrentUser() admin: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportUpdateDto) {
    const r = await this.prisma.report.update({ where: { id }, data: { status: dto.status, resolutionNote: dto.resolutionNote } });
    await this.audit(admin.id, `REPORT_${dto.status}`, 'Report', id, { note: dto.resolutionNote });
    return r;
  }

  @Get('payments')
  payments() {
    return this.prisma.payment.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Get('audit-logs')
  auditLogs() {
    return this.prisma.adminAuditLog.findMany({
      include: { admin: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** Aggregate operational analytics only (no personal data). */
  @Get('stats')
  async stats() {
    const [drivers, pendingDrivers, customers, bookings, completed, cancelled, openReports, referrals, approvedReferrals] = await Promise.all([
      this.prisma.driverProfile.count({ where: { verificationStatus: 'APPROVED' } }),
      this.prisma.driverProfile.count({ where: { verificationStatus: 'PENDING' } }),
      this.prisma.user.count({ where: { roles: { has: 'CUSTOMER' } } }),
      this.prisma.booking.count(),
      this.prisma.booking.count({ where: { state: 'COMPLETED' } }),
      this.prisma.booking.count({ where: { state: { in: ['CANCELLED', 'DECLINED', 'EXPIRED'] } } }),
      this.prisma.report.count({ where: { status: { in: ['OPEN', 'INVESTIGATING'] } } }),
      this.prisma.referral.count(),
      this.prisma.referral.count({ where: { state: 'CUSTOMER_APPROVED' } }),
    ]);
    return {
      verifiedDrivers: drivers, pendingDrivers, customers, bookings, completed, cancelled, openReports,
      completionRate: bookings ? completed / bookings : null,
      referrals, referralSuccessRate: referrals ? approvedReferrals / referrals : null,
    };
  }
}
