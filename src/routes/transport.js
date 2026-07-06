import { Router } from "express";
import { db } from "@workspace/db";
import { transportRoutesTable, vehiclesTable, staffTable, studentsTable, studentTransportAssignmentsTable, usersTable, classesTable, feeRecordsTable, transportLogsTable, driverLiveLocationsTable  } from "@workspace/db";
// import { eq, and, sql, inArray } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { hashPassword } from "../lib/password";
import { sendEmail } from "../lib/email.js";
import { eq, and, sql, inArray } from "drizzle-orm";


const router = Router();
const managerRoles = ["admin", "transport_manager"];
const writeRoles = ["admin", "transport_manager"];
// ─── ROUTES ────────────────────────────────────────────────────────────────
router.get("/transport/routes", requireRole(...managerRoles, "driver", "parent", "student"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const routes = await db.select().from(transportRoutesTable);
        const vehicles = await db.select().from(vehiclesTable);
        const staff = await db.select().from(staffTable);
        const assignments = await db.select().from(studentTransportAssignmentsTable);
        const vehicleMap = Object.fromEntries(vehicles.map((v) => [v.id, v]));
        const driverMap = Object.fromEntries(staff.map((s) => [s.id, s]));
        const enriched = routes.map((r) => {
            const vehicle = r.vehicleId ? vehicleMap[r.vehicleId] : null;
            const driver = vehicle?.driverId ? driverMap[vehicle.driverId] : null;
            return {
                ...r,
                vehicleNumber: vehicle?.vehicleNumber ?? null,
                driverName: driver?.name ?? null,
                driverPhone: driver?.phone ?? null,
                studentCount: assignments.filter((a) => a.routeId === r.id).length,
            };
        });
        // Driver: only see routes whose vehicle is assigned to them (via staff.userId === req.user.id)
        if (req.user.role === "driver") {
            const myStaff = staff.find((s) => s.userId === req.user.id);
            const myVehicleIds = vehicles.filter((v) => v.driverId === myStaff?.id).map((v) => v.id);
            return res.json(enriched.filter((r) => r.vehicleId && myVehicleIds.includes(r.vehicleId)));
        }
        // Student/parent: only the route their (children's) assignment is on
        if (req.user.role === "student" || req.user.role === "parent") {
            const { resolveOwnStudentIds } = await import("../lib/scope");
            const ownStudentIds = new Set(await resolveOwnStudentIds(req.user));
            const myRouteIds = new Set(assignments.filter((a) => ownStudentIds.has(a.studentId)).map((a) => a.routeId));
            return res.json(enriched.filter((r) => myRouteIds.has(r.id)));
        }
        return res.json(enriched);
    }
    catch (err) {
        req.log.error({ err }, "List transport routes error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/transport/routes", requireRole(...writeRoles), async (req, res) => {
    try {
        const data = req.body;
        const [route] = await db.insert(transportRoutesTable).values({
            name: data.name,
            startPoint: data.startPoint,
            endPoint: data.endPoint,
            vehicleId: data.vehicleId ?? null,
            stops: data.stops ?? null,
            morningTime: data.morningTime ?? null,
            eveningTime: data.eveningTime ?? null,
            distance: data.distance != null && data.distance !== "" ? String(data.distance) : null,
            fare: data.fare != null && data.fare !== "" ? String(data.fare) : null,
            status: "active",
        }).returning();
        return res.status(201).json({ ...route, vehicleNumber: null, driverName: null, driverPhone: null, studentCount: 0 });
    }
    catch (err) {
        req.log.error({ err }, "Create transport route error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/transport/routes/:id", requireRole(...writeRoles), async (req, res) => {
    try {
        const data = req.body;
        const upd = {};
        if (data.vehicleId !== undefined)
            upd.vehicleId = data.vehicleId;
        if (data.stops !== undefined)
            upd.stops = data.stops;
        if (data.status !== undefined)
            upd.status = data.status;
        if (data.morningTime !== undefined)
            upd.morningTime = data.morningTime;
        if (data.eveningTime !== undefined)
            upd.eveningTime = data.eveningTime;
        if (data.startPoint !== undefined)
            upd.startPoint = data.startPoint;
        if (data.endPoint !== undefined)
            upd.endPoint = data.endPoint;
        if (data.name !== undefined)
            upd.name = data.name;
        if (data.distance !== undefined)
            upd.distance = data.distance === "" || data.distance == null ? null : String(data.distance);
        if (data.fare !== undefined)
            upd.fare = data.fare === "" || data.fare == null ? null : String(data.fare);
        const [updated] = await db.update(transportRoutesTable).set(upd).where(eq(transportRoutesTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json({ ...updated, vehicleNumber: null, driverName: null, driverPhone: null, studentCount: 0 });
    }
    catch (err) {
        req.log.error({ err }, "Update transport route error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/transport/routes/:id", requireRole(...writeRoles), async (req, res) => {
    try {
        const routeId = parseInt(String(req.params.id));
        const [deleted] = await db.delete(transportRoutesTable).where(eq(transportRoutesTable.id, routeId)).returning();
        if (!deleted)
            return res.status(404).json({ error: "Not found" });
        await db.delete(studentTransportAssignmentsTable).where(eq(studentTransportAssignmentsTable.routeId, routeId));
        return res.json({ ok: true });
    }
    catch (err) {
        req.log.error({ err }, "Delete transport route error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─── VEHICLES ──────────────────────────────────────────────────────────────
router.get("/transport/vehicles", requireRole(...managerRoles, "driver", "student", "parent"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const all = await db.select().from(vehiclesTable);
        const staff = await db.select().from(staffTable);
        const staffMap = Object.fromEntries(staff.map((s) => [s.id, s]));
        const enriched = all.map((v) => ({
            ...v,
            driverName: v.driverId ? (staffMap[v.driverId]?.name ?? null) : null,
            driverPhone: v.driverId ? (staffMap[v.driverId]?.phone ?? null) : null,
        }));
        if (req.user.role === "driver") {
            const myStaff = staff.find((s) => s.userId === req.user.id);
            return res.json(enriched.filter((v) => v.driverId === myStaff?.id));
        }
        return res.json(enriched);
    }
    catch (err) {
        req.log.error({ err }, "List vehicles error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/transport/vehicles", requireRole(...writeRoles), async (req, res) => {
    try {
        const data = req.body;
        const [vehicle] = await db.insert(vehiclesTable).values({
            vehicleNumber: data.vehicleNumber,
            type: data.type,
            capacity: data.capacity,
            driverId: data.driverId ?? null,
            model: data.model ?? null,
            insuranceExpiry: data.insuranceExpiry ?? null,
            status: data.status ?? "active",
        }).returning();
        return res.status(201).json({ ...vehicle, driverName: null, driverPhone: null });
    }
    catch (err) {
        req.log.error({ err }, "Create vehicle error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/transport/vehicles/:id", requireRole(...writeRoles), async (req, res) => {
    try {
        const data = req.body;
        const upd = {};
        for (const k of ["vehicleNumber", "type", "capacity", "driverId", "model", "insuranceExpiry", "status"]) {
            if (data[k] !== undefined)
                upd[k] = data[k];
        }
        const [updated] = await db.update(vehiclesTable).set(upd).where(eq(vehiclesTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json(updated);
    }
    catch (err) {
        req.log.error({ err }, "Update vehicle error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/transport/vehicles/:id", requireRole(...writeRoles), async (req, res) => {
    try {
        const vehicleId = parseInt(String(req.params.id));
        await db.update(transportRoutesTable).set({ vehicleId: null }).where(eq(transportRoutesTable.vehicleId, vehicleId));
        const [deleted] = await db.delete(vehiclesTable).where(eq(vehiclesTable.id, vehicleId)).returning();
        if (!deleted)
            return res.status(404).json({ error: "Not found" });
        return res.json({ ok: true });
    }
    catch (err) {
        req.log.error({ err }, "Delete vehicle error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─── DRIVERS ────────────────────────────────────────────────────────────────
// Drivers are staff rows whose role='driver', backed by a user account (role='driver')
router.get("/transport/drivers", requireRole(...managerRoles), async (req, res) => {
    try {
        const drivers = await db.select().from(staffTable).where(eq(staffTable.role, "driver"));
        const vehicles = await db.select().from(vehiclesTable);
        const users = await db.select().from(usersTable);
        const userMap = Object.fromEntries(users.map((u) => [u.id, u.username]));
        return res.json(drivers.map((d) => {
            const v = vehicles.find((vv) => vv.driverId === d.id);
            return {
                id: d.id,
                name: d.name,
                phone: d.phone,
                email: d.email,
                username: d.userId ? (userMap[d.userId] ?? null) : null,
                licenseNo: d.qualification ?? null,
                status: d.status,
                userId: d.userId,
                assignedVehicleId: v?.id ?? null,
                assignedVehicleNumber: v?.vehicleNumber ?? null,
            };
        }));
    }
    catch (err) {
        req.log.error({ err }, "List drivers error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/transport/drivers", requireRole(...writeRoles), async (req, res) => {
    try {
        const { name, phone, email, licenseNo, username, password, assignedVehicleId } = req.body ?? {};
        if (!name || !phone || !username || !password) {
            return res.status(400).json({ error: "name, phone, username, password are required" });
        }
        // Transactionally create user + staff (+ optional vehicle assignment)
        const userEmail = email && String(email).trim() ? String(email).trim() : `${String(username).toLowerCase()}@drivers.local`;
        let user;
        let staff;
        try {
            const result = await db.transaction(async (tx) => {
                const [u] = await tx.insert(usersTable).values({
                    username: String(username).toLowerCase(),
                    password: await hashPassword(String(password)),
                    role: "driver",
                    name,
                    email: userEmail,
                    phone,
                }).returning();
                const [s] = await tx.insert(staffTable).values({
                    name,
                    role: "driver",
                    department: "Transport",
                    email: userEmail,
                    phone,
                    qualification: licenseNo ?? null,
                    joinDate: new Date().toISOString().split("T")[0],
                    status: "active",
                    userId: u.id,
                }).returning();
                if (assignedVehicleId) {
                    await tx.update(vehiclesTable).set({ driverId: s.id }).where(eq(vehiclesTable.id, parseInt(String(assignedVehicleId))));
                }
                return { u, s };
            });
            user = result.u;
            staff = result.s;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("duplicate") || msg.includes("unique")) {
                return res.status(409).json({ error: "Username already taken" });
            }
            throw e;
        }
        const shouldSendCredentialsEmail = email && String(email).trim();
        if (shouldSendCredentialsEmail) {
            const html = `<p>Hello ${name},</p>
<p>Your driver account has been created. You can log in with the following credentials:</p>
<ul>
  <li><strong>Username:</strong> ${user.username}</li>
  <li><strong>Password:</strong> ${String(password)}</li>
</ul>
<p>Please sign in at <a href="${process.env.APP_URL ?? "http://localhost:4173"}">${process.env.APP_URL ?? "http://localhost:4173"}</a> and change your password after logging in.</p>
<p>Thank you,<br/>Transport Team</p>`;
            sendEmail(userEmail, "Your driver account credentials", html).catch((emailErr) => {
                req.log.error({ err: emailErr, email: userEmail }, "Failed to send driver credentials email");
            });
        }
        return res.status(201).json({
            id: staff.id,
            name: staff.name,
            phone: staff.phone,
            email: staff.email,
            licenseNo: staff.qualification ?? null,
            status: staff.status,
            userId: staff.userId,
            assignedVehicleId: assignedVehicleId ? parseInt(String(assignedVehicleId)) : null,
            username: user.username,
            emailSent: Boolean(shouldSendCredentialsEmail),
        });
    }
    catch (err) {
        req.log.error({ err }, "Create driver error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch(
  "/transport/routes/:id",
  requireRole("admin", "transport_manager"),
  async (req, res) => {
    try {
      const routeId = Number(req.params.id);

      const existingRoute = await db
        .select()
        .from(transportRoutesTable)
        .where(eq(transportRoutesTable.id, routeId))
        .limit(1);

      if (!existingRoute[0]) {
        return res.status(404).json({
          error: "Route not found"
        });
      }

      const updateData = {
        ...req.body,
      };

      await db
        .update(transportRoutesTable)
        .set(updateData)
        .where(eq(transportRoutesTable.id, routeId));

      return res.json({
        ok: true,
        message: "Route updated successfully"
      });

    } catch (err) {
      console.error(err);

      return res.status(500).json({
        error: "Internal server error"
      });
    }
  }
);
router.delete("/transport/drivers/:id", requireRole(...writeRoles), async (req, res) => {
    try {
        const driverId = parseInt(req.params.id);
        const existing = await db.select().from(staffTable).where(eq(staffTable.id, driverId)).limit(1);
        if (!existing[0]) return res.status(404).json({ error: "Driver not found" });

        await db.transaction(async (tx) => {
            await tx.update(vehiclesTable).set({ driverId: null }).where(eq(vehiclesTable.driverId, driverId));
            await tx.delete(usersTable).where(eq(usersTable.id, existing[0].userId));
            await tx.delete(staffTable).where(eq(staffTable.id, driverId));
        });

        return res.json({ ok: true });
    } catch (err) {
        req.log.error(err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.patch("/transport/drivers/:id", requireRole(...writeRoles), async (req, res) => {
    try {
        const driverId = parseInt(req.params.id);
        const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, driverId)).limit(1);
        if (!staff) return res.status(404).json({ error: "Driver not found" });

        const { name, phone, email, licenseNo, username, password, assignedVehicleId } = req.body ?? {};

        await db.transaction(async (tx) => {
            // 1. Update user if user fields changed
            const userUpd = {};
            if (username) userUpd.username = String(username).toLowerCase();
            if (name) userUpd.name = name;
            if (email) userUpd.email = email;
            if (phone) userUpd.phone = phone;
            if (password) userUpd.password = await hashPassword(password);

            if (Object.keys(userUpd).length > 0 && staff.userId) {
                await tx.update(usersTable).set(userUpd).where(eq(usersTable.id, staff.userId));
            }

            // 2. Update staff
            const staffUpd = {};
            if (name) staffUpd.name = name;
            if (phone) staffUpd.phone = phone;
            if (email) staffUpd.email = email;
            if (licenseNo !== undefined) staffUpd.qualification = licenseNo;

            if (Object.keys(staffUpd).length > 0) {
                await tx.update(staffTable).set(staffUpd).where(eq(staffTable.id, driverId));
            }

            // 3. Update vehicle assignment
            if (assignedVehicleId !== undefined) {
                await tx.update(vehiclesTable).set({ driverId: null }).where(eq(vehiclesTable.driverId, driverId));
                if (assignedVehicleId && assignedVehicleId !== "none") {
                    await tx.update(vehiclesTable).set({ driverId: driverId }).where(eq(vehiclesTable.id, parseInt(assignedVehicleId)));
                }
            }
        });

        return res.json({ ok: true, message: "Driver updated successfully" });
    } catch (err) {
        req.log.error(err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── STUDENT TRANSPORT ASSIGNMENTS ────────────────────────────────────────
router.get("/transport/assignments", requireRole(...managerRoles, "driver"), async (req, res) => {
    try {
        const assignments = await db.select().from(studentTransportAssignmentsTable);
        const students = await db.select().from(studentsTable);
        const routes = await db.select().from(transportRoutesTable);
        const classes = await db.select().from(classesTable);
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s]));
        const routeMap = Object.fromEntries(routes.map((r) => [r.id, r]));
        const classMap = Object.fromEntries(classes.map((c) => [c.id, `${c.grade}-${c.section}`]));
        let filtered = assignments;
        if (req.user.role === "driver") {
            const staff = await db.select().from(staffTable);
            const vehicles = await db.select().from(vehiclesTable);
            const myStaff = staff.find((s) => s.userId === req.user.id);
            const myVehicleIds = vehicles.filter((v) => v.driverId === myStaff?.id).map((v) => v.id);
            const myRouteIds = routes.filter((r) => r.vehicleId && myVehicleIds.includes(r.vehicleId)).map((r) => r.id);
            filtered = assignments.filter((a) => myRouteIds.includes(a.routeId));
        }
        return res.json(filtered.map((a) => {
            const st = studentMap[a.studentId];
            const rt = routeMap[a.routeId];
            const cls = st?.classId ? classMap[st.classId] : null;
            return {
                ...a,
                studentName: st?.name ?? null,
                studentRoll: st?.rollNumber ?? null,
                className: cls ?? null,
                routeName: rt?.name ?? null,
                studentAvatarUrl: st?.avatarUrl ?? null,
            };
        }));
    }
    catch (err) {
        req.log.error({ err }, "List assignments error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/transport/assignments", requireRole(...writeRoles), async (req, res) => {
    try {
        const { studentId, routeId, pickupStop, dropStop } = req.body ?? {};
        if (!studentId || !routeId)
            return res.status(400).json({ error: "studentId and routeId are required" });
        // Capacity guard: enforce vehicle capacity if route has a vehicle
        const route = (await db.select().from(transportRoutesTable).where(eq(transportRoutesTable.id, Number(routeId))))[0];
        if (!route)
            return res.status(404).json({ error: "Route not found" });
        if (route.vehicleId) {
            const vehicle = (await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, route.vehicleId)))[0];
            if (vehicle) {
                const onRoute = (await db.select().from(studentTransportAssignmentsTable).where(eq(studentTransportAssignmentsTable.routeId, route.id))).length;
                if (onRoute >= vehicle.capacity) {
                    return res.status(409).json({ error: `Vehicle ${vehicle.vehicleNumber} is at full capacity (${vehicle.capacity})` });
                }
            }
        }
        // Prevent duplicate active assignment for the same student
        const existing = await db.select().from(studentTransportAssignmentsTable).where(eq(studentTransportAssignmentsTable.studentId, Number(studentId)));
        if (existing.length > 0) {
            return res.status(409).json({ error: "Student already has a transport assignment. Remove the existing one first." });
        }
        const [created] = await db.insert(studentTransportAssignmentsTable).values({
            studentId: Number(studentId),
            routeId: Number(routeId),
            pickupStop: pickupStop ?? null,
            dropStop: dropStop ?? null,
            feeStatus: "pending",
        }).returning();
        // Auto-create a transport fee for the term
        try {
            const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            await db.insert(feeRecordsTable).values({
                studentId: created.studentId,
                feeType: "transport",
                amount: "1500",
                dueDate,
                academicYear: new Date().getFullYear() + "-" + String(new Date().getFullYear() + 1).slice(-2),
                status: "pending",
            });
        }
        catch (e) {
            req.log.warn({ err: e }, "Could not auto-generate transport fee");
        }
        return res.status(201).json(created);
    }
    catch (err) {
        req.log.error({ err }, "Create assignment error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/transport/assignments/:id", requireRole(...writeRoles), async (req, res) => {
    try {
        const data = req.body ?? {};
        const upd = {};
        if (data.pickupStop !== undefined)
            upd.pickupStop = data.pickupStop;
        if (data.dropStop !== undefined)
            upd.dropStop = data.dropStop;
        if (data.feeStatus !== undefined)
            upd.feeStatus = data.feeStatus;
        if (data.routeId !== undefined) {
            const newRouteId = Number(data.routeId);
            const route = (await db.select().from(transportRoutesTable).where(eq(transportRoutesTable.id, newRouteId)))[0];
            if (!route)
                return res.status(404).json({ error: "Target route not found" });
            if (route.vehicleId) {
                const vehicle = (await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, route.vehicleId)))[0];
                if (vehicle) {
                    const onRoute = (await db.select().from(studentTransportAssignmentsTable).where(eq(studentTransportAssignmentsTable.routeId, newRouteId))).length;
                    if (onRoute >= vehicle.capacity) {
                        return res.status(409).json({ error: `Target vehicle ${vehicle.vehicleNumber} is at full capacity (${vehicle.capacity})` });
                    }
                }
            }
            upd.routeId = newRouteId;
        }
        const [updated] = await db.update(studentTransportAssignmentsTable).set(upd).where(eq(studentTransportAssignmentsTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json(updated);
    }
    catch (err) {
        req.log.error({ err }, "Update assignment error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/transport/assignments/:id", requireRole(...writeRoles), async (req, res) => {
    try {
        const [deleted] = await db.delete(studentTransportAssignmentsTable).where(eq(studentTransportAssignmentsTable.id, parseInt(String(req.params.id)))).returning();
        if (!deleted)
            return res.status(404).json({ error: "Not found" });
        return res.json({ ok: true });
    }
    catch (err) {
        req.log.error({ err }, "Delete assignment error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─── DRIVER CONVENIENCE ENDPOINT ──────────────────────────────────────────
router.get("/transport/my-route", requireRole("driver"), async (req, res) => {
    try {
        const staff = (await db.select().from(staffTable).where(and(eq(staffTable.userId, req.user.id), eq(staffTable.role, "driver"))))[0];
        if (!staff)
            return res.json({ vehicle: null, route: null, manifest: [] });
        const vehicle = (await db.select().from(vehiclesTable).where(eq(vehiclesTable.driverId, staff.id)))[0] ?? null;
        if (!vehicle)
            return res.json({ driver: { id: staff.id, name: staff.name }, vehicle: null, route: null, manifest: [] });
        const route = (await db.select().from(transportRoutesTable).where(eq(transportRoutesTable.vehicleId, vehicle.id)))[0] ?? null;
        if (!route)
            return res.json({ driver: { id: staff.id, name: staff.name }, vehicle, route: null, manifest: [] });
        const assignments = await db.select().from(studentTransportAssignmentsTable).where(eq(studentTransportAssignmentsTable.routeId, route.id));
        const students = await db.select().from(studentsTable);
        const classes = await db.select().from(classesTable);
        const classMap = Object.fromEntries(classes.map((c) => [c.id, `${c.grade}-${c.section}`]));
        const manifest = assignments.map((a) => {
            const st = students.find((s) => s.id === a.studentId);
            return {
                assignmentId: a.id,
                studentId: a.studentId,
                studentName: st?.name ?? "Unknown",
                rollNumber: st?.rollNumber ?? null,
                className: st?.classId ? classMap[st.classId] ?? null : null,
                pickupStop: a.pickupStop,
                dropStop: a.dropStop,
                feeStatus: a.feeStatus,
                studentAvatarUrl: st?.avatarUrl ?? null,
            };
        });
        return res.json({
            driver: { id: staff.id, name: staff.name, phone: staff.phone, licenseNo: staff.qualification ?? null },
            vehicle,
            route,
            manifest,
        });
    }
    catch (err) {
        req.log.error({ err }, "My route error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── TRANSPORT LOGS ────────────────────────────────────────────────────────
router.post("/transport/logs", requireRole("admin", "transport_manager", "driver"), async (req, res) => {
    try {
        const { studentId, routeId, action, location } = req.body ?? {};
        if (!studentId || !routeId || !action) {
            return res.status(400).json({ error: "studentId, routeId, and action are required" });
        }
        if (action !== "boarded" && action !== "deboarded") {
            return res.status(400).json({ error: "action must be 'boarded' or 'deboarded'" });
        }
        const [log] = await db.insert(transportLogsTable).values({
            studentId: Number(studentId),
            routeId: Number(routeId),
            action,
            location: location ?? null,
        }).returning();
        return res.status(201).json(log);
    }
    catch (err) {
        req.log.error({ err }, "Create transport log error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/transport/logs", requireRole("admin", "transport_manager", "driver", "student", "parent"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        
        const logs = await db.select().from(transportLogsTable);
        const students = await db.select().from(studentsTable);
        const routes = await db.select().from(transportRoutesTable);
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s]));
        const routeMap = Object.fromEntries(routes.map((r) => [r.id, r]));

        let enriched = logs.map((l) => ({
            ...l,
            studentName: studentMap[l.studentId]?.name ?? null,
            routeName: routeMap[l.routeId]?.name ?? null,
            studentAvatarUrl: studentMap[l.studentId]?.avatarUrl ?? null,
        }));

        if (req.user.role === "student" || req.user.role === "parent") {
            const { resolveOwnStudentIds } = await import("../lib/scope");
            const ownStudentIds = new Set(await resolveOwnStudentIds(req.user));
            enriched = enriched.filter((l) => ownStudentIds.has(l.studentId));
        } else if (req.user.role === "driver") {
            const staff = await db.select().from(staffTable);
            const vehicles = await db.select().from(vehiclesTable);
            const myStaff = staff.find((s) => s.userId === req.user.id);
            const myVehicleIds = vehicles.filter((v) => v.driverId === myStaff?.id).map((v) => v.id);
            const myRouteIds = new Set(routes.filter((r) => r.vehicleId && myVehicleIds.includes(r.vehicleId)).map((r) => r.id));
            enriched = enriched.filter((l) => myRouteIds.has(l.routeId));
        }

        enriched.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return res.json(enriched);
    }
    catch (err) {
        req.log.error({ err }, "List transport logs error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

const liveGpsLocations = new Map();

router.post("/transport/routes/:id/gps", async (req, res) => {
    try {
        const routeId = parseInt(req.params.id);
        const { latitude, longitude, speed } = req.body;
        if (!latitude || !longitude) {
            return res.status(400).json({ error: "latitude and longitude are required" });
        }
        liveGpsLocations.set(routeId, {
            latitude: Number(latitude),
            longitude: Number(longitude),
            speed: speed ? Number(speed) : 0,
            updatedAt: new Date().toISOString()
        });
        return res.json({ success: true, message: `GPS location updated for route ${routeId}` });
    }
    catch (err) {
        req.log.error({ err }, "GPS update error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/transport/routes/:id/live", async (req, res) => {
    try {
        const routeId = parseInt(req.params.id);
        const loc = liveGpsLocations.get(routeId);
        if (!loc) {
            return res.status(404).json({ error: "No live GPS location available for this route" });
        }
        return res.json(loc);
    }
    catch (err) {
        req.log.error({ err }, "Get live location error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/transport/routes/:id/delay", requireRole("admin", "transport_manager", "driver","parent"), async (req, res) => {
    try {
        const routeId = parseInt(req.params.id);
        const { delayMinutes, reason } = req.body;
        if (delayMinutes === undefined || !reason) {
            return res.status(400).json({ error: "delayMinutes and reason are required" });
        }
        const [route] = await db.select().from(transportRoutesTable).where(eq(transportRoutesTable.id, routeId));
        if (!route) {
            return res.status(404).json({ error: "Route not found" });
        }
        const { announcementsTable } = await import("@workspace/db");
        await db.insert(announcementsTable).values({
            title: `Transport Route Delay: ${route.name}`,
            content: `The transport route ${route.name} is currently delayed by ${delayMinutes} minutes. Reason: ${reason}.`,
            audience: "all",
            priority: "urgent",
            authorId: req.user?.id ?? 1
        });
        return res.json({ success: true, message: `Delay notification triggered for route ${route.name}` });
    }
    catch (err) {
        req.log.error({ err }, "Trigger delay notification error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
 
// ─── LIVE GPS TRACKING - FINAL FIXED VERSION ───────────────────────────────
router.post("/transport/drivers/live-location", requireRole("driver", "admin", "transport_manager","parent"), async (req, res) => {
    try {
        const { lat, lng, speed, accuracy, heading } = req.body;

        if (!lat || !lng) {
            return res.status(400).json({ error: "lat and lng are required" });
        }

        let driverId = null;

        // === Force resolve from logged-in user (most secure) ===
        if (req.user?.role === "driver" && req.user?.id) {
            const [staff] = await db
                .select({ id: staffTable.id })
                .from(staffTable)
                .where(eq(staffTable.userId, req.user.id))
                .limit(1);

            if (!staff) {
                return res.status(400).json({ 
                    error: "Driver profile not found. Please contact administrator." 
                });
            }

            driverId = staff.id;
        } 
        // Allow admin/transport_manager to specify driverId (optional)
        else if (req.body.driverId) {
            driverId = parseInt(req.body.driverId);
        }

        if (!driverId) {
            return res.status(400).json({ error: "Unable to determine driver ID" });
        }

        // Save location
        await db.insert(driverLiveLocationsTable).values({
            driverId,
            lat: String(lat),
            lng: String(lng),
            speed: speed != null ? String(speed) : null,
            accuracy: accuracy != null ? String(accuracy) : null,
            heading: heading != null ? String(heading) : null,
        }).onConflictDoUpdate({
            target: driverLiveLocationsTable.driverId,
            set: {
                lat: sql`EXCLUDED.lat`,
                lng: sql`EXCLUDED.lng`,
                speed: sql`EXCLUDED.speed`,
                accuracy: sql`EXCLUDED.accuracy`,
                heading: sql`EXCLUDED.heading`,
                lastUpdated: sql`NOW()`,
            },
        });

        return res.json({ 
            success: true, 
            message: "Live location updated successfully",
            driverId 
        });

    } catch (err) {
        console.error("Live GPS Error:", err);
        req.log.error({ err }, "Live GPS error");
        return res.status(500).json({ 
            error: "Failed to save location",
            message: err.message 
        });
    }
});





// routes/parent.js or in transport.js / user.js

// GET /api/parent/children
// ====================== GET PARENT'S CHILDREN ======================
router.get('/parent/children', requireRole, async (req, res) => {
  try {
    if (req.user.role !== 'parent') {
      return res.status(403).json({ error: "Only parents can access this" });
    }

    const children = await prisma.student.findMany({
      where: {
        parentId: req.user.id,        // Adjust if your relation is different
      },
      select: {
        id: true,
        name: true,
        rollNumber: true,
        className: true,
        classId: true,
      },
      orderBy: { name: 'asc' }
    });

    res.json({ data: children });
  } catch (error) {
    console.error("Parent children error:", error);
    res.status(500).json({ error: "Failed to fetch children" });
  }
});
// ─── GET LIVE LOCATION (Manager + Student Support) ─────────────────────
// ─── GET LIVE LOCATION ─────────────────────────────────────────────────────
// ─── GET LIVE LOCATION ─────────────────────────────────────────────────────
router.get("/transport/drivers/live", async (req, res) => {
    try {
        const driverIdQuery = req.query.driverId ? parseInt(req.query.driverId) : null;

        if (!driverIdQuery) {
            return res.status(400).json({ error: "driverId is required" });
        }

        // ====================== STUDENT / PARENT ACCESS ======================
        if (req.user?.role === "student" || req.user?.role === "parent") {
            // Import the scope resolver
            const { resolveOwnStudentIds } = await import("../lib/scope");
            const ownStudentIds = await resolveOwnStudentIds(req.user);

            if (!ownStudentIds || ownStudentIds.length === 0) {
                return res.status(403).json({ error: "Access denied - No students found" });
            }

            // FIX: Use inArray to properly handle the student IDs
            const { inArray } = await import("drizzle-orm");
            
            // Verify this parent/student is assigned to this driver
          // Alternative without inArray
const assignment = await db
    .select({ driverId: staffTable.id })
    .from(studentTransportAssignmentsTable)
    .innerJoin(transportRoutesTable, eq(transportRoutesTable.id, studentTransportAssignmentsTable.routeId))
    .innerJoin(vehiclesTable, eq(vehiclesTable.id, transportRoutesTable.vehicleId))
    .innerJoin(staffTable, eq(staffTable.id, vehiclesTable.driverId))
    .where(
        sql`${studentTransportAssignmentsTable.studentId} = ANY(${sql.raw(`ARRAY[${ownStudentIds.join(',')}]`)}) 
        AND ${staffTable.id} = ${driverIdQuery}`
    )
    .limit(1);

            if (assignment.length === 0) {
                return res.status(403).json({ error: "You are not authorized to track this driver" });
            }
        } 
        // ====================== MANAGER ACCESS ======================
        else if (!["admin", "transport_manager"].includes(req.user?.role)) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Fetch live location
        const [liveLoc] = await db
            .select({
                driverId: driverLiveLocationsTable.driverId,
                lat: driverLiveLocationsTable.lat,
                lng: driverLiveLocationsTable.lng,
                speed: driverLiveLocationsTable.speed,
                accuracy: driverLiveLocationsTable.accuracy,
                heading: driverLiveLocationsTable.heading,
                lastUpdated: driverLiveLocationsTable.lastUpdated,
                driverName: staffTable.name,
                vehicleNumber: vehiclesTable.vehicleNumber,
            })
            .from(driverLiveLocationsTable)
            .innerJoin(staffTable, eq(staffTable.id, driverLiveLocationsTable.driverId))
            .leftJoin(vehiclesTable, eq(vehiclesTable.driverId, driverLiveLocationsTable.driverId))
            .where(eq(driverLiveLocationsTable.driverId, driverIdQuery));

        if (!liveLoc) {
            return res.json({ 
                driverId: driverIdQuery, 
                lat: null, 
                lng: null, 
                message: "No live location available yet" 
            });
        }

        return res.json(liveLoc);

    } catch (err) {
        console.error("Get live location error:", err);
        req.log?.error({ err }, "Get live location error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// routes/api/transport/drivers/stop-tracking.js  (or in your main transport route file)

// POST /api/transport/drivers/stop-tracking
router.post("/transport/drivers/stop-tracking", requireRole("driver", "admin", "transport_manager","parent"), async (req, res) => {
    try {
        let driverId = null;

        // Force resolve from logged-in user (most secure for drivers)
        if (req.user?.role === "driver" && req.user?.id) {
            const [staff] = await db
                .select({ id: staffTable.id })
                .from(staffTable)
                .where(eq(staffTable.userId, req.user.id))
                .limit(1);

            if (staff) driverId = staff.id;
        } 
        // Allow admin/manager to stop for any driver
        else if (req.body.driverId) {
            driverId = parseInt(req.body.driverId);
        }

        if (!driverId) {
            return res.status(400).json({ error: "Unable to determine driver ID" });
        }

        // Option 1: Delete record (simple but loses last location)
        // await db.delete(driverLiveLocationsTable).where(eq(driverLiveLocationsTable.driverId, driverId));

        // Option 2: Keep last location but mark as inactive (RECOMMENDED)
        // First check if record exists
        const existing = await db
            .select({ driverId: driverLiveLocationsTable.driverId })
            .from(driverLiveLocationsTable)
            .where(eq(driverLiveLocationsTable.driverId, driverId))
            .limit(1);

        if (existing.length > 0) {
            await db
                .update(driverLiveLocationsTable)
                .set({ 
                    lastUpdated: sql`NOW() - INTERVAL '1 day'`, // Force old timestamp
                    // If you can add isActive column later, use it instead
                })
                .where(eq(driverLiveLocationsTable.driverId, driverId));
        }

        return res.json({ 
            success: true, 
            message: "Tracking stopped successfully",
            driverId 
        });

    } catch (err) {
        console.error("Stop Tracking Error:", err);
        req.log.error({ err }, "Stop tracking error");
        return res.status(500).json({ 
            error: "Failed to stop tracking",
            message: err.message 
        });
    }
});



// ─── STUDENT / PARENT: My Assigned Driver & Vehicle ───────────────────────
// ─── STUDENT / PARENT: My Assigned Driver & Vehicle ───────────────────────
router.get("/transport/my-assignment", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    let studentIds = [];

    if (req.user.role === "student") {
       const student = await db
        .select({ id: studentsTable.id })
        .from(studentsTable)
        .where(eq(studentsTable.userId, req.user.id))
        .limit(1);
      
      if (student.length > 0) {
        studentIds = [student[0].id];
      }
    } 
    else if (req.user.role === "parent") {
      const { resolveOwnStudentIds } = await import("../lib/scope");
      studentIds = await resolveOwnStudentIds(req.user);
    }

    if (studentIds.length === 0) {
      return res.json(null);
    }

    // FIX: Use inArray instead of sql template
   // For the my-assignment endpoint - use sql.raw instead
const result = await db
    .select({
        driverId: staffTable.id,
        driverName: staffTable.name,
        driverPhone: staffTable.phone,
        driverLicense: staffTable.qualification,
        vehicleNumber: vehiclesTable.vehicleNumber,
        vehicleId: vehiclesTable.id,
        routeId: transportRoutesTable.id,
        routeName: transportRoutesTable.name,
    })
    .from(studentTransportAssignmentsTable)
    .innerJoin(transportRoutesTable, eq(transportRoutesTable.id, studentTransportAssignmentsTable.routeId))
    .innerJoin(vehiclesTable, eq(vehiclesTable.id, transportRoutesTable.vehicleId))
    .innerJoin(staffTable, eq(staffTable.id, vehiclesTable.driverId))
    .where(
        sql`${studentTransportAssignmentsTable.studentId} = ANY(${sql.raw(`ARRAY[${studentIds.join(',')}]`)})`
    )
    .limit(1);

    return res.json(result[0] || null);

  } catch (err) {
    console.error("My assignment error:", err);
    return res.status(500).json({ error: "Failed to load transport assignment" });
  }
});
// ─── BOARD / UNBOARD ENDPOINT (with Time Validation Safety) ─────────────────
router.post("/transport/board", requireRole("driver", "admin", "transport_manager","parent"), async (req, res) => {
    try {
        const { studentId, routeId, trip, action, location } = req.body ?? {};

        if (!studentId || !routeId || !action) {
            return res.status(400).json({ 
                error: "studentId, routeId, and action are required" 
            });
        }

        if (!["boarded", "unboarded"].includes(action)) {
            return res.status(400).json({ 
                error: "action must be 'boarded' or 'unboarded'" 
            });
        }

        const studentIdNum = Number(studentId);
        const routeIdNum = Number(routeId);

        // 1. Verify student is assigned to this route
        const assignment = await db
            .select()
            .from(studentTransportAssignmentsTable)
            .where(and(
                eq(studentTransportAssignmentsTable.studentId, studentIdNum),
                eq(studentTransportAssignmentsTable.routeId, routeIdNum)
            ))
            .limit(1);

        if (assignment.length === 0) {
            return res.status(403).json({ 
                error: "Student is not assigned to this route" 
            });
        }

        // 2. Verify route exists
        const [route] = await db
            .select()
            .from(transportRoutesTable)
            .where(eq(transportRoutesTable.id, routeIdNum));

        if (!route) {
            return res.status(404).json({ error: "Route not found" });
        }

        // 3. Extra Backend Time Validation (Safety net)
        if (action === "boarded" && trip) {
            const timeStr = trip === "morning" ? route.morningTime : route.eveningTime;
            
            if (timeStr) {
                const [hours, minutes] = timeStr.split(":").map(Number);
                const scheduled = new Date();
                scheduled.setHours(hours, minutes, 0, 0);

                const diffMinutes = Math.abs((Date.now() - scheduled.getTime()) / (1000 * 60));

                if (diffMinutes > 35) {   // Slightly more lenient on backend (35 mins)
                    return res.status(400).json({
                        error: `Boarding for ${trip} trip is only allowed near scheduled time (${timeStr})`
                    });
                }
            }
        }

        // 4. Prevent double boarding
        if (action === "boarded") {
            const recentLog = await db
                .select()
                .from(transportLogsTable)
                .where(and(
                    eq(transportLogsTable.studentId, studentIdNum),
                    eq(transportLogsTable.routeId, routeIdNum),
                    eq(transportLogsTable.action, "boarded")
                ))
                .orderBy(sql`timestamp DESC`)
                .limit(1);

            if (recentLog.length > 0) {
                // Check if already deboarded after last boarding
                const lastDeboard = await db
                    .select()
                    .from(transportLogsTable)
                    .where(and(
                        eq(transportLogsTable.studentId, studentIdNum),
                        eq(transportLogsTable.routeId, routeIdNum),
                        eq(transportLogsTable.action, "deboarded")
                    ))
                    .orderBy(sql`timestamp DESC`)
                    .limit(1);

                if (lastDeboard.length === 0 || 
                    new Date(lastDeboard[0].timestamp) < new Date(recentLog[0].timestamp)) {
                    return res.status(409).json({ 
                        error: "Student is already on the bus" 
                    });
                }
            }
        }

        // 5. Create Log
        const [log] = await db.insert(transportLogsTable).values({
            studentId: studentIdNum,
            routeId: routeIdNum,
            action,
            location: location ?? null,
            trip: trip || null,           // morning / evening
            recordedBy: req.user?.id || null,
        }).returning();

        return res.status(201).json({
            success: true,
            message: `Student ${action === "boarded" ? "boarded" : "deboarded"} successfully`,
            log
        });

    } catch (err) {
        req.log.error({ err }, "Board/Unboard error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

export default router;