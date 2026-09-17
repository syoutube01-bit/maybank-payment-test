const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve HTML
app.use(express.static(path.join(__dirname, "public")));

// Payment status screen (deep link target: /paymentstatus?oid=MBB232)
app.get("/paymentstatus", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "paymentstatus.html"));
});

// Create Maybank payment order
app.post("/api/create-order", async (req, res) => {
    try {
        const {
            webinitToken,
            partnerInvoiceId,
            partnerReferenceId,
            currency,
            amount,
            remark
        } = req.body;

        if (!webinitToken) {
            return res.status(400).json({
                success: false,
                message: "webinitToken is required"
            });
        }

        const requestBody = {
            partnerInvoiceId,
            partnerReferenceId,
            currency,
            amount,
            remark
        };

        const response = await axios.post(
            "https://payments-npas.maybank.com.my/sit/payment-sdk/v1/orders",
            requestBody,
            {
                headers: {
                    "Content-Type": "application/json",

                    "x-mb-client-id":
                        "mbb-mae-maybank-heart",

                    "x-mb-e2e-id":
                        "346918df-af88-4b3a-95e3-273eebf30aea",

                    "x-mb-env":
                        "U",

                    "x-mb-timestamp":
                        Date.now().toString(),

                    "dip-authorization":
                        `bearer ${webinitToken}`
                }
            }
        );

        return res.status(response.status).json({
            success: true,
            data: response.data
        });

    } catch (error) {

        console.error(
            "Maybank API Error:",
            error.response?.data || error.message
        );

        return res.status(
            error.response?.status || 500
        ).json({
            success: false,
            message: "Unable to create payment order",
            error: error.response?.data || error.message
        });
    }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});