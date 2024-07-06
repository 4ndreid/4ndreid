<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Aplikasi Stock Gudang Bahan Baku Pakan</title>
    <style>
        /* CSS sama seperti sebelumnya */
    </style>
    <script src="https://www.gstatic.com/firebasejs/8.10.0/firebase-app.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.0/firebase-database.js"></script>
</head>
<body>
    <h1>Aplikasi Stock Gudang Bahan Baku Pakan</h1>
    
    <nav>
        <a href="#" onclick="loadData('kedatangan')">Kedatangan</a>
        <a href="#" onclick="loadData('pengeluaran')">Pengeluaran</a>
        <a href="#" onclick="loadData('stockAkhir')">Stock Akhir</a>
    </nav>
    
    <div id="content"></div>

    <script>
        // Konfigurasi Firebase Anda
        const firebaseConfig = {
            // Masukkan konfigurasi Firebase Anda di sini
        };

        // Inisialisasi Firebase
        firebase.initializeApp(firebaseConfig);
        const database = firebase.database();

        function loadData(path) {
            database.ref(path).once('value').then((snapshot) => {
                const data = snapshot.val();
                displayData(path, data);
            });
        }

        function displayData(path, data) {
            let tableHTML = `<h2>${path.charAt(0).toUpperCase() + path.slice(1)}</h2><table>`;
            
            if (data) {
                // Membuat header tabel
                tableHTML += '<tr>';
                Object.keys(data[Object.keys(data)[0]]).forEach(key => {
                    tableHTML += `<th>${key}</th>`;
                });
                tableHTML += '</tr>';

                // Membuat baris data
                Object.values(data).forEach(row => {
                    tableHTML += '<tr>';
                    Object.values(row).forEach(cell => {
                        tableHTML += `<td>${cell}</td>`;
                    });
                    tableHTML += '</tr>';
                });
            } else {
                tableHTML += '<tr><td>Tidak ada data</td></tr>';
            }

            tableHTML += '</table>';
            document.getElementById('content').innerHTML = tableHTML;
        }

        // Load data Kedatangan saat halaman dimuat
        loadData('kedatangan');
    </script>
</body>
</html>
