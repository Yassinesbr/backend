import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

function monthKey(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  private getMonthRange(monthDate: Date) {
    const start = new Date(
      Date.UTC(
        monthDate.getUTCFullYear(),
        monthDate.getUTCMonth(),
        1,
        0,
        0,
        0,
        0,
      ),
    );
    const end = new Date(
      Date.UTC(
        monthDate.getUTCFullYear(),
        monthDate.getUTCMonth() + 1,
        1,
        0,
        0,
        0,
        0,
      ),
    );
    return { start, end };
  }

  async overview() {
    const now = new Date();
    const { start: monthStart, end: monthEnd } = this.getMonthRange(now);

    // Basic counts
    const [totalStudents, totalTeachers, totalClasses, totalSubjects] =
      await Promise.all([
        this.prisma.student.count(),
        this.prisma.teacher.count(),
        this.prisma.class.count(),
        (
          this.prisma as unknown as {
            subject: { count: () => Promise<number> };
          }
        ).subject.count(),
      ]);

    // Payment status distribution
    const paymentStatusGroups = await this.prisma.student
      .groupBy({
        by: ['paymentStatus'],
        _count: { paymentStatus: true },
      })
      .catch(
        () =>
          [] as {
            paymentStatus: string | null;
            _count: { paymentStatus: number };
          }[],
      );
    const paymentStatusDistribution: Record<string, number> = {};
    for (const g of paymentStatusGroups) {
      const key = g.paymentStatus ?? 'unknown';
      paymentStatusDistribution[key] = g._count.paymentStatus;
    }

    // Current month invoices (based on billedMonth on items)
    const monthInvoices = await this.prisma.invoice.findMany({
      where: {
        items: { some: { billedMonth: { gte: monthStart, lt: monthEnd } } },
      },
      include: { items: true },
    });
    let currentMonthInvoicedCents = 0;
    let currentMonthPaidCents = 0;
    monthInvoices.forEach((inv) => {
      currentMonthInvoicedCents += inv.items.reduce(
        (s, i) => s + i.lineTotalCents,
        0,
      );
      currentMonthPaidCents += inv.items.reduce(
        (s, i) => s + (i.paidCents ?? 0),
        0,
      );
    });
    const currentMonthRemainingCents =
      currentMonthInvoicedCents - currentMonthPaidCents;
    const currentMonthPaymentRate =
      currentMonthInvoicedCents > 0
        ? currentMonthPaidCents / currentMonthInvoicedCents
        : 0;

    // Overdue invoices
    const overdueInvoices = await this.prisma.invoice.findMany({
      where: { status: 'OVERDUE' },
      include: { items: true },
    });
    let overdueAmountCents = 0;
    overdueInvoices.forEach((inv) => {
      const subtotal = inv.items.reduce((s, i) => s + i.lineTotalCents, 0);
      const paid = inv.items.reduce((s, i) => s + (i.paidCents ?? 0), 0);
      overdueAmountCents += Math.max(0, subtotal - paid);
    });

    // Recent invoices & payments
    const recentInvoices = await this.prisma.invoice.findMany({
      orderBy: { issueDate: 'desc' },
      take: 5,
      include: { student: { include: { user: true } }, items: true },
    });
    const recentPayments = await this.prisma.payment.findMany({
      orderBy: { paidAt: 'desc' },
      take: 5,
      include: {
        invoice: { include: { student: { include: { user: true } } } },
      },
    });

    // Top classes by enrollment (limit 5)
    interface RawClassTeacherUser {
      firstName: string | null;
      lastName: string | null;
    }
    interface RawClassTeacher {
      user: RawClassTeacherUser | null;
    }
    type RawClassStudent = Record<string, unknown>; // placeholder structural type
    interface RawClass {
      id: string;
      name: string;
      pricingMode: 'PER_STUDENT' | 'FIXED_TOTAL';
      monthlyPriceCents: number | null;
      fixedMonthlyPriceCents: number | null;
      students: RawClassStudent[];
      teacher: RawClassTeacher | null;
    }
    const topClassesRaw = await (
      this.prisma as unknown as {
        class: { findMany: (args: unknown) => Promise<RawClass[]> };
      }
    ).class.findMany({
      include: { students: true, teacher: { include: { user: true } } },
    });
    const topClasses = topClassesRaw
      .map((c) => {
        const studentCount = c.students?.length || 0;
        const estimatedRevenueCents =
          c.pricingMode === 'FIXED_TOTAL'
            ? (c.fixedMonthlyPriceCents ?? 0)
            : (c.monthlyPriceCents ?? 0) * studentCount;
        const teacherName = c.teacher?.user
          ? `${c.teacher.user.firstName ?? ''} ${c.teacher.user.lastName ?? ''}`.trim()
          : undefined;
        return {
          id: c.id,
          name: c.name,
          teacher: teacherName,
          studentCount,
          pricingMode: c.pricingMode,
          estimatedRevenueCents,
        };
      })
      .sort((a, b) => b.studentCount - a.studentCount)
      .slice(0, 5);

    // Students by level (academic hierarchy) - join through classes -> subject -> track -> level
    const studentsWithClasses = await this.prisma.student.findMany({
      include: {
        classes: {
          include: {
            subject: { include: { track: { include: { level: true } } } },
          },
        },
      },
    });
    const studentsByLevel: Record<string, number> = {};
    studentsWithClasses.forEach((s) => {
      const levelNames = new Set<string>(
        (s.classes as { subject?: { track?: { level?: { name?: string } } } }[])
          .map((c) => c.subject?.track?.level?.name)
          .filter((n): n is string => !!n),
      );
      if (levelNames.size === 0) {
        studentsByLevel['Unassigned'] =
          (studentsByLevel['Unassigned'] || 0) + 1;
      } else {
        levelNames.forEach((lvl) => {
          studentsByLevel[lvl] = (studentsByLevel[lvl] || 0) + 1;
        });
      }
    });

    // Monthly revenue trend (last 6 months including current) using invoice items billedMonth
    const sixMonthsAgo = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1),
    );
    const invoiceItems = await this.prisma.invoiceItem.findMany({
      where: { billedMonth: { gte: sixMonthsAgo, lte: monthEnd } },
    });
    const monthMap: Record<
      string,
      { invoicedCents: number; paidCents: number }
    > = {};
    invoiceItems.forEach((item) => {
      const k = monthKey(item.billedMonth);
      monthMap[k] = monthMap[k] || { invoicedCents: 0, paidCents: 0 };
      monthMap[k].invoicedCents += item.lineTotalCents;
      monthMap[k].paidCents += item.paidCents ?? 0;
    });
    const monthlyRevenue = [] as {
      month: string;
      invoicedCents: number;
      paidCents: number;
    }[];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
      );
      const mk = monthKey(d);
      monthlyRevenue.push({
        month: mk,
        invoicedCents: monthMap[mk]?.invoicedCents || 0,
        paidCents: monthMap[mk]?.paidCents || 0,
      });
    }

    // Upcoming classes (next 7 days) based on classTimes schedule (no calendar exceptions)
    const classTimes = await this.prisma.classTime.findMany({
      include: { class: { include: { teacher: { include: { user: true } } } } },
    });
    const upcomingSessions: {
      id: string;
      classId: string;
      className: string;
      teacher?: string;
      start: string;
      end: string;
      dayOfWeek: number;
    }[] = [];
    const horizon = 7; // days
    for (const ct of classTimes) {
      for (let offset = 0; offset < horizon; offset++) {
        const date = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + offset,
          ),
        );
        if (date.getUTCDay() === ct.dayOfWeek) {
          const start = new Date(date);
          start.setUTCMinutes(ct.startMinutes, 0, 0);
          const end = new Date(date);
          end.setUTCMinutes(ct.endMinutes, 0, 0);
          const clsInfo = ct as unknown as {
            class?: {
              name?: string | null;
              teacher?: {
                user?: {
                  firstName?: string | null;
                  lastName?: string | null;
                } | null;
              } | null;
            };
          };
          const teacherUser = clsInfo.class?.teacher?.user;
          const teacherName = teacherUser
            ? `${teacherUser.firstName ?? ''} ${teacherUser.lastName ?? ''}`.trim()
            : undefined;
          upcomingSessions.push({
            id: `${ct.id}-${date.toISOString().split('T')[0]}`,
            classId: ct.classId,
            className: clsInfo.class?.name || 'Unnamed',
            teacher: teacherName,
            start: start.toISOString(),
            end: end.toISOString(),
            dayOfWeek: ct.dayOfWeek,
          });
        }
      }
    }
    upcomingSessions.sort((a, b) => a.start.localeCompare(b.start));

    return {
      generatedAt: new Date().toISOString(),
      counts: { totalStudents, totalTeachers, totalClasses, totalSubjects },
      payments: {
        paymentStatusDistribution,
        currentMonth: {
          invoicedCents: currentMonthInvoicedCents,
          paidCents: currentMonthPaidCents,
          remainingCents: currentMonthRemainingCents,
          paymentRate: currentMonthPaymentRate,
        },
        overdue: {
          invoices: overdueInvoices.length,
          amountCents: overdueAmountCents,
        },
        recentInvoices: recentInvoices.map((inv) => ({
          id: inv.id,
          number: inv.number,
          issueDate: inv.issueDate,
          status: inv.status,
          student: inv.student?.user
            ? `${inv.student.user.firstName ?? ''} ${inv.student.user.lastName ?? ''}`.trim() ||
              inv.student.user.email
            : undefined,
          subtotalCents: inv.items.reduce((s, i) => s + i.lineTotalCents, 0),
          paidCents: inv.items.reduce((s, i) => s + (i.paidCents ?? 0), 0),
        })),
        recentPayments: recentPayments.map((p) => ({
          id: p.id,
          paidAt: p.paidAt,
          amountCents: p.amountCents,
          student: p.invoice?.student?.user
            ? `${p.invoice.student.user.firstName ?? ''} ${p.invoice.student.user.lastName ?? ''}`.trim() ||
              p.invoice.student.user.email
            : undefined,
          invoiceNumber: p.invoice?.number,
          method: p.method,
        })),
        monthlyRevenue,
      },
      academics: {
        studentsByLevel,
        topClasses,
      },
      schedule: {
        upcomingSessions: upcomingSessions.slice(0, 15),
      },
    };
  }
}
