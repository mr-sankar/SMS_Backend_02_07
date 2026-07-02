import { db } from "@workspace/db";
import { hostelMealsTable, hostelNoticesTable } from "@workspace/db";
import { logger } from "./logger";
const INITIAL_MEALS = [
    { day: "Monday", breakfast: "Idli Sambar, Coffee", lunch: "Rice, Dal, Sabzi, Roti", dinner: "Roti, Paneer Curry, Salad" },
    { day: "Tuesday", breakfast: "Poha, Tea", lunch: "Rice, Rajma, Papad, Chaas", dinner: "Roti, Dal Makhani, Rice" },
    { day: "Wednesday", breakfast: "Upma, Juice", lunch: "Chole Bhature, Raita", dinner: "Roti, Sabzi, Dal Tadka" },
    { day: "Thursday", breakfast: "Paratha, Curd", lunch: "Rice, Sambar, Rasam", dinner: "Roti, Mixed Veg, Kheer" },
    { day: "Friday", breakfast: "Bread Butter, Boiled Eggs", lunch: "Pulao, Raita, Papad", dinner: "Roti, Palak Paneer, Rice" },
    { day: "Saturday", breakfast: "Puri Bhaji, Tea", lunch: "Biryani, Raita, Salan", dinner: "Roti, Dal, Aloo Gobi" },
    { day: "Sunday", breakfast: "Dosa Chutney, Coffee", lunch: "Special Thali (4 items)", dinner: "Roti, Shahi Paneer, Gulab Jamun" },
];
const INITIAL_NOTICES = [
    { title: "Hostel Gate Timings", body: "Gates will be closed at 10:00 PM sharp. All students must return by 9:45 PM.", urgent: true },
    { title: "Monthly Maintenance", body: "Room inspection scheduled for 25th of every month. Keep rooms clean and tidy.", urgent: false },
    { title: "Guest Visit Rules", body: "Guests are allowed only in common areas between 9 AM and 6 PM. No guests in rooms.", urgent: false },
];
export async function ensureHostelSeedData() {
    try {
        const existingMeals = await db.select().from(hostelMealsTable);
        if (existingMeals.length === 0) {
            await db.insert(hostelMealsTable).values(INITIAL_MEALS);
            logger.info("Seeded initial hostel meal schedule");
        }
        const existingNotices = await db.select().from(hostelNoticesTable);
        if (existingNotices.length === 0) {
            await db.insert(hostelNoticesTable).values(INITIAL_NOTICES);
            logger.info("Seeded initial hostel notices");
        }
    }
    catch (err) {
        logger.warn({ err }, "Hostel seed failed (non-fatal)");
    }
}
