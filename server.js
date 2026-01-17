require('dotenv').config(); 

const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const jwt = require('jsonwebtoken');

const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// --- SETUP FOLDER UPLOADS ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// --- KONFIGURASI MULTER ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'));
    }
});

// Init Multer
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// Middleware Global
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('uploads'));

// --- DATABASE ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306, 
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect(err => {
    if (err) {
        console.error('DB Error: ' + err.stack);
        return;
    }
    console.log(`Connected to MySQL on host: ${process.env.DB_HOST}, port: ${process.env.DB_PORT || 3306}`);
});

// --- HELPER ---
const getBaseUrl = (req) => `${req.protocol}://10.0.2.2:${PORT}`;

// ROUTES 

// 1. REGISTER
app.post('/api/auth/register', (req, res) => {
    const { full_name, email, password } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);
    db.query("INSERT INTO users (full_name, email, password, role) VALUES (?, ?, ?, 'Penulis')",
        [full_name, email, hashedPassword], (err) => {
            if (err) return res.status(400).json({ status: false, message: "Email sudah ada" });
            res.json({ status: true, message: "Registrasi Berhasil" });
        });
});

// 2. LOGIN (JWT)
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    db.query("SELECT * FROM users WHERE email = ?", [email], (err, results) => {
        if (results.length === 0 || !bcrypt.compareSync(password, results[0].password)) {
            return res.status(401).json({ status: false, message: "Email/Password salah" });
        }
        const user = results[0];
        const token = jwt.sign({ id: user.user_id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
        res.json({
            status: true, message: "Login Berhasil", token: token,
            data: { user_id: user.user_id, email: user.email, full_name: user.full_name, role: user.role }
        });
    });
});

// 3. GET ARTICLES (List)
app.get('/api/articles', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 20 
    const offset = (page - 1) * limit;

    const keyword = req.query.q;
    const categoryId = req.query.category_id;

    let query = `
        SELECT a.article_id, a.user_id, a.category_id, a.title, a.content, 
               a.published_at, a.views_count, a.status, a.tags,
               u.full_name AS author_name, c.category_name
        FROM articles a
        JOIN users u ON a.user_id = u.user_id
        LEFT JOIN categories c ON a.category_id = c.category_id
        WHERE a.status = 'Published' 
    `;
    
    const params = [];

    if (categoryId) {
        query += ` AND a.category_id = ?`;
        params.push(categoryId);
    }

    if (keyword) {
        query += ` AND (a.title LIKE ? OR a.content LIKE ? OR c.category_name LIKE ? OR a.tags LIKE ?)`;
        params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    query += ` ORDER BY a.published_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    db.query(query, params, (err, articles) => {
        if (err) return res.status(500).json({ status: false, message: "Server Error" });
        if (articles.length === 0) return res.json({ status: true, message: "Kosong", data: [] });

        const ids = articles.map(a => a.article_id);
        db.query(`SELECT * FROM article_images WHERE article_id IN (?) ORDER BY sort_order ASC`, [ids], (errImg, images) => {
            const baseUrl = getBaseUrl(req);
            const data = articles.map(art => {
                const articleImages = images.filter(img => img.article_id === art.article_id);
                const imageUrls = articleImages.map(img => `${baseUrl}/uploads/${img.image_path}`);
                const captions = articleImages.map(img => img.caption || "");
                
                return { ...art, images: imageUrls, captions: captions };
            });
            res.json({ status: true, data: data });
        });
    });
});

// 4. GET CATEGORIES
app.get('/api/categories', (req, res) => {
    db.query("SELECT * FROM categories ORDER BY category_name ASC", (err, resDb) => {
        res.json({ status: true, data: resDb });
    });
});

// 5. GET DETAIL 
app.get('/api/articles/:id', (req, res) => {
    const id = req.params.id;
    db.query("UPDATE articles SET views_count = views_count + 1 WHERE article_id = ?", [id]);

    const query = `
        SELECT a.*, u.full_name AS author_name, c.category_name
        FROM articles a
        JOIN users u ON a.user_id = u.user_id
        LEFT JOIN categories c ON a.category_id = c.category_id
        WHERE a.article_id = ?
    `;
    db.query(query, [id], (err, results) => {
        if (err || results.length === 0) return res.status(404).json({ status: false, message: "Not Found" });
        const article = results[0];

        db.query("SELECT image_path, caption FROM article_images WHERE article_id = ? ORDER BY sort_order ASC", [id], (errI, imgs) => {
            const baseUrl = getBaseUrl(req);
            const imageList = imgs.map(img => `${baseUrl}/uploads/${img.image_path}`);
            const captionList = imgs.map(img => img.caption || ""); // Handle null
            
            res.json({ 
                status: true, 
                data: { ...article, images: imageList, captions: captionList } 
            });
        });
    });
});

// --- 6. UPLOAD ARTICLE ---
app.post('/api/articles', upload.array('images'), (req, res) => {
    const { title, user_id, status, tags } = req.body;
    let { content, category_id } = req.body;

    let captions = [];
    try { captions = JSON.parse(req.body.captions || '[]'); } catch (e) { captions = []; }

    if (!content) content = "";
    if (!category_id) category_id = 7;

    if (!title || !user_id) {
        return res.status(400).json({ status: false, message: "Judul wajib diisi" });
    }

    // --- LOGIKA RATE LIMITING ---
    const checkLimitSql = `
        SELECT COUNT(*) as count 
        FROM articles 
        WHERE user_id = ? AND DATE(created_at) = CURDATE()
    `;

    db.query(checkLimitSql, [user_id], (errLimit, resLimit) => {
        if (errLimit) return res.status(500).json({ status: false, message: "Gagal cek limit" });

        const countToday = resLimit[0].count;

        if (countToday >= 10) {
            if (req.files && req.files.length > 0) {
                req.files.forEach(f => {
                    try { fs.unlinkSync(f.path); } catch(e) {}
                });
            }
            return res.status(429).json({ 
                status: false, 
                message: "Batas harian tercapai! Maksimal 10 artikel per hari." 
            });
        }

        const articleStatus = status || 'Draft';
        const publishedAt = (articleStatus === 'Published') ? new Date() : null;

        const sql = "INSERT INTO articles (title, content, category_id, user_id, status, published_at, tags) VALUES (?, ?, ?, ?, ?, ?, ?)";

        db.query(sql, [title, content, category_id, user_id, articleStatus, publishedAt, tags], (err, result) => {
            if (err) return res.status(500).json({ status: false, message: "Database Error" });

            const newId = result.insertId;
            if (req.files && req.files.length > 0) {
                const imageValues = req.files.map((file, index) => {
                    const cap = captions[index] || ""; 
                    return [newId, file.filename, index + 1, cap];
                });
                
                const sqlImg = "INSERT INTO article_images (article_id, image_path, sort_order, caption) VALUES ?";
                db.query(sqlImg, [imageValues], () => res.json({ status: true, message: "Berhasil Disimpan" }));
            } else {
                res.json({ status: true, message: "Berhasil Disimpan" });
            }
        });
    });
});

// 7. MY ARTICLES
app.get('/api/users/:id/articles', (req, res) => {
    const userId = req.params.id;
    const query = "SELECT a.*, c.category_name FROM articles a LEFT JOIN categories c ON a.category_id = c.category_id WHERE a.user_id = ? ORDER BY a.created_at DESC";

    db.query(query, [userId], (err, articles) => {
        if (err) return res.status(500).json({ status: false });
        if (articles.length === 0) return res.json({ status: true, data: [] });

        const ids = articles.map(a => a.article_id);
        db.query(`SELECT * FROM article_images WHERE article_id IN (?) ORDER BY sort_order ASC`, [ids], (errImg, images) => {
            const baseUrl = getBaseUrl(req);
            const data = articles.map(art => {
                const myImages = images.filter(img => img.article_id === art.article_id);
                const imageUrls = myImages.map(img => `${baseUrl}/uploads/${img.image_path}`);
                const captions = myImages.map(img => img.caption || "");
                
                return { ...art, images: imageUrls, captions: captions, author_name: "You" };
            });
            res.json({ status: true, data: data });
        });
    });
});

// 8. DELETE ARTICLE
app.delete('/api/articles/:id', (req, res) => {
    const id = req.params.id;
    db.query("SELECT image_path FROM article_images WHERE article_id = ?", [id], (err, imgs) => {
        if (imgs) {
            imgs.forEach(img => {
                const p = path.join(uploadDir, img.image_path);
                if (fs.existsSync(p)) fs.unlinkSync(p);
            });
        }
        db.query("DELETE FROM articles WHERE article_id = ?", [id], () => {
            res.json({ status: true, message: "Terhapus" });
        });
    });
});

// --- 9. UPDATE ARTICLE ---
app.put('/api/articles/:id', upload.array('images'), (req, res) => {
    const id = req.params.id;
    const { title, content, category_id, status, tags, deleted_images } = req.body;
    
    let allCaptions = [];
    try {
        allCaptions = JSON.parse(req.body.captions || '[]');
    } catch (e) { allCaptions = []; }

    // Update Data Artikel Utama
    let sql = "UPDATE articles SET title = ?, content = ?, category_id = ?, status = ?, tags = ?";
    const params = [title, content, category_id, status || 'Draft', tags];
    
    if (status === 'Published') sql += ", published_at = NOW()";
    sql += " WHERE article_id = ?";
    params.push(id);

    db.query(sql, params, (err) => {
        if (err) return res.status(500).json({ status: false, message: "Gagal update database" });

        // HAPUS GAMBAR
        if (deleted_images) {
            let imagesToDelete = [];
            try {
                imagesToDelete = JSON.parse(deleted_images);
            } catch (e) {
                imagesToDelete = Array.isArray(deleted_images) ? deleted_images : [deleted_images];
            }

            if (Array.isArray(imagesToDelete)) {
                imagesToDelete.forEach(url => {
                    const filename = path.basename(url); 
                    
                    const p = path.join(uploadDir, filename);
                    if (fs.existsSync(p)) {
                        try { fs.unlinkSync(p); } catch(e) { console.log("Gagal hapus file:", e); }
                    }

                    db.query("DELETE FROM article_images WHERE article_id = ? AND image_path = ?", [id, filename]);
                });
            }
        }

        // Tambah gambar baru
        const insertNewImages = () => {
            return new Promise((resolve) => {
                if (req.files && req.files.length > 0) {
                    db.query("SELECT MAX(sort_order) as m FROM article_images WHERE article_id = ?", [id], (errOrder, resOrder) => {
                        let next = (resOrder[0].m || 0) + 1;
                        const newImages = req.files.map((file, idx) => [id, file.filename, next + idx, ""]);
                        db.query("INSERT INTO article_images (article_id, image_path, sort_order, caption) VALUES ?", [newImages], () => {
                            resolve();
                        });
                    });
                } else {
                    resolve();
                }
            });
        };

        // Update Caption 
        insertNewImages().then(() => {
            db.query("SELECT image_id FROM article_images WHERE article_id = ? ORDER BY sort_order ASC", [id], (errF, currentImages) => {
                if (currentImages && currentImages.length > 0) {
                    currentImages.forEach((img, idx) => {
                        if (idx < allCaptions.length) {
                            const newCap = allCaptions[idx];
                            db.query("UPDATE article_images SET caption = ? WHERE image_id = ?", [newCap, img.image_id]);
                        }
                    });
                }
                res.json({ status: true, message: "Update Berhasil" });
            });
        });
    });
});

// 10. GET USER
app.get('/api/users/:id', (req, res) => {
    db.query("SELECT user_id, email, full_name, bio, role, profile_photo FROM users WHERE user_id = ?", [req.params.id], (err, resDb) => {
        if (resDb.length === 0) return res.status(404).json({ status: false });
        res.json({ status: true, data: resDb[0] });
    });
});

// 11. UPDATE PROFILE
app.put('/api/users/:id', upload.single('profile_photo'), (req, res) => {
    const id = req.params.id;
    const { full_name, bio, email, password } = req.body;

    let sql = "UPDATE users SET full_name = ?, bio = ?, email = ?";
    let params = [full_name, bio, email];

    if (password) {
        sql += ", password = ?";
        params.push(bcrypt.hashSync(password, 10));
    }
    if (req.file) {
        sql += ", profile_photo = ?";
        params.push(req.file.filename);
    }

    sql += " WHERE user_id = ?";
    params.push(id);

    db.query(sql, params, (err) => {
        if (err) return res.status(500).json({ status: false });
        db.query("SELECT user_id, email, full_name, bio, role, profile_photo FROM users WHERE user_id = ?", [id], (e, r) => {
            res.json({ status: true, message: "Profil Update", data: r[0] });
        });
    });
});

// 12. DELETE USER
app.delete('/api/users/:id', (req, res) => {
    const id = req.params.id;
    db.query(`SELECT image_path FROM article_images WHERE article_id IN (SELECT article_id FROM articles WHERE user_id = ?)`, [id], (e, imgs) => {
        if (imgs) imgs.forEach(i => {
            try { fs.unlinkSync(path.join(uploadDir, i.image_path)); } catch (e) { }
        });
        db.query("DELETE FROM users WHERE user_id = ?", [id], () => {
            res.json({ status: true, message: "User Deleted" });
        });
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));