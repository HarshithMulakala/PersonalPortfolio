
const projectsData = [
    {
        id: "Speakl",
        title: "Speakl",
        description: "Speakl is a real-time, AI-powered speaking coach for interviews and more. It listens, analyzes delivery, and provides instant feedback on pacing, clarity, filler words, and confidence so you can practice and improve faster.",
        image: "./SpeaklLogo.png",
        link: "https://speakl.ai",
        category: "project"
    },
    {
        id: "AdFusion",
        title: "ACM Research AdFusion",
        description: "AdFusion is an ACM Research project where we fine-tuned large language and image models to generate high quality advertising creatives. It focused on building a full data pipeline, scraping and structuring ad assets, and training models to produce realistic ad captions and visuals for marketing use cases.",
        image: "./AdFusion.jpg",
        link: "https://github.com/AakristG/AdFusion",
        category: "project"
    },
    {
        id: "PlayAI",
        title: "PlayAI",
        description: "PlayAI is a CLI prompt-to-2D Unity game tool. Describe a simple game in natural language and generate a playable 2D prototype with scaffolded scenes, prefabs, and scripts to accelerate experimentation.",
        image: "./playai.jpg",
        link: "https://github.com/HarshithMulakala/PlayAI",
        category: "project"
    },
    {
        id: "CurryCal",
        title: "CurryCal",
        description: "CurryCal is a South Asian calorie tracking app that can count calories from photos. Snap a picture of your meal and get instant estimates tailored to regional dishes, making healthy tracking effortless.",
        image: "./currycal.png",
        link: "https://github.com/HarshithMulakala/CuryCalAI",
        category: "project"
    },
    {
        id: "BraveBear",
        title: "Brave Bear",
        description: "Brave Bear is a unique app created using React Native for the frontend and Firebase for the backend. The app provides a safe space for teenagers to connect with professionals who specialize in mental health, offering free sessions to help them navigate through their struggles. With a user-friendly interface built through react-native alongside secure chat functionality and profile picture storage done through the integration of Google Firebase, Brave Bear empowers teens to seek support, fostering a community that promotes mental well-being and personal growth.",
        image: "./BraveBear.png", // Using the png from file structure if available, or base64 from html? HTML has base64. I should check if BraveBear.png exists. File list says yes.
        link: "https://github.com/HarshithMulakala/BackOnTrack",
        category: "project"
    },
    {
        id: "BulletBounce",
        title: "Bullet Bounce",
        description: "Bullet Bounce is an engaging 2D puzzle game created for DonkeyClick and submitted as part of a mini game jam. In this unique and challenging experience, the player takes control of a character and strategically fires a bullet, skillfully aiming to hit themselves. Behind the scenes, the entire backend code of the game was expertly crafted using the powerful C# programming language within the Unity game development engine. Through meticulous coding, the intricate mechanics and physics of bullet trajectory, collision detection, and player interactions were brought to life, resulting in a seamless and immersive gameplay experience.",
        image: "https://img.itch.zone/aW1nLzk2MzA2MDgucG5n/315x250%23c/7ToN2z.png",
        link: "https://cert.itch.io/bullet-bounce",
        category: "project"
    },
    {
        id: "QBot",
        title: "Q Bot",
        description: "Q Bot is a powerful Discord bot developed using JavaScript and the Discord.js library. Its primary function is to enhance the music listening experience in voice channels by allowing users to play music from YouTube links. Leveraging the capabilities of Discord.js, the bot effortlessly handles commands to play, pause, and stop music, while also providing the flexibility to skip to the next song in the queue. The bot's queue feature ensures a smooth playback experience, allowing users to add multiple songs to the playlist and enjoy uninterrupted music. Moreover, Q Bot has been engineered to be versatile enough to serve multiple servers simultaneously, catering to the needs of numerous communities. Its seamless integration with Discord and reliable performance through the hosting of the bot by replit has garnered widespread adoption, attracting hundreds of users who enjoy its music playback functionality and other features.",
        image: "https://img-cdn.tnwcdn.com/image?fit=1280%2C720&url=https%3A%2F%2Fcdn0.tnwcdn.com%2Fwp-content%2Fblogs.dir%2F1%2Ffiles%2F2021%2F07%2FDiscordhed.jpg&signature=257006462207519026282958af872e5c",
        link: "https://github.com/HarshithMulakala/ReaderBot",
        category: "project"
    },
    {
        id: "Cashonomics", // Included just in case, though not in html slider
        title: "Cashonomics Website",
        description: "Cashonomics Website is a dynamic website I have specifically designed and coded for the nonprofit organization, aimed at promoting financial literacy and economic empowerment. Leveraging the power of SCSS, HTML, and JS, the website offers a visually appealing and user-friendly interface. The integration of Firebase as the backend infrastructure empowers administrators to create and manage engaging and informative blogs directly on the website. Through this seamless platform, admins can effortlessly share valuable insights, tips, and resources, fostering an interactive and educational community focused on improving financial well-being and understanding.",
        image: "https://shahs-website.vercel.app/images/Cashonomics.png",
        link: "http://shahs-website.vercel.app/",
        category: "project_hidden" // Marking hidden unless I find it in the grid
    }
];

const workData = [
    {
        id: "iTalentii",
        title: "iTalentii Tech",
        description: "During my internship at iTalentii Tech, I served as a developer/assistant, helping the design and development of an app that provides access to the best deals and coupons on products. I took charge of the UI/UX design, employing tools like MidJourney and color palettes to create an appealing and user-friendly interface with using React/React-Native to bring this interface to life. Additionally, I developed some core functionality, implementing web scraping techniques to gather data from platforms like Amazon and Reddit, seamlessly integrating it into the app's categories. This experience enhanced my skills in UI/UX design, web scraping, data manipulation, and API integration, while also fostering qualities like responsibility and initiative. Overall, this internship deepened my understanding of computer science, equipping me with critical thinking, problem-solving, and adaptability—essential foundations for a successful career in the field.",
        image: "./Logo.PNG",
        link: "",
        category: "work"
    },
    {
        id: "CashonomicsWork",
        title: "Cashonomics Work",
        description: "Cashonomics is a student-led non-profit organization dedicated to promoting financial literacy across all age groups. As a Web Developer and Student Advisory Board Member, my role within the organization is multifaceted. I was responsible for the complete development of Cashonomics' website, including designing the user interface, implementing backend functionality, and crafting HTML/CSS elements. Beyond web development, I also serve as a valuable consultant, leveraging my expertise in technology and emphasizing the importance of establishing an online presence. Through my guidance and connections, I contribute to building relationships for the organization and educating its members about specific technological needs and the significance of utilizing technology to further the organizations mission of financial education.",
        image: "https://shahs-website.vercel.app/images/Cashonomics.png",
        link: "http://shahs-website.vercel.app/",
        category: "work"
    },
    {
        id: "DonkeyClick",
        title: "DonkeyClick",
        description: "DonkeyClick is an indie game company founded by me and two friends, specializing in the development and release of engaging mobile and PC games on various platforms, including the app store. As the main software developer and a founder, I assume a pivotal role in overseeing all projects, ensuring their successful execution along with coding a good majority of the functionality of each project. Currently we are only using Unity and C#, but look to expand into engines like Unreal Engine in the future. With exciting titles like Bullet Bounce and Bombkey Thief already under our belt, DonkeyClick has a promising future with a pipeline of upcoming projects.",
        image: "./donkeyclick.png",
        link: "",
        category: "work"
    }
];

$(document).ready(function () {
    // Mobile Menu Toggle
    $('#menu-icon').click(function () {
        $('#menu-icon').toggleClass('bx-x');
        $(".nav").toggleClass("open");
    });

    // Resume Toggle
    $('.resumebutton').click(function () {
        $('.Resume').addClass('open');
    });
    $('.closeresume').click(function () {
        $('.Resume').removeClass('open');
    });

    // Initial Render
    renderGrid(projectsData.filter(p => p.category === 'project'), 'projects-grid');
    renderGrid(workData, 'work-grid');
    
    // Tab Switching
    $('.tab-btn').click(function() {
        $('.tab-btn').removeClass('active');
        $(this).addClass('active');
        
        const tab = $(this).data('tab');
        if(tab === 'projects') {
            $('#projects-grid').fadeIn();
            $('#work-grid').hide();
        } else {
            $('#work-grid').fadeIn().css('display', 'grid');
            $('#projects-grid').hide();
        }
    });

    // Modal Close
    $('.close, .popup-container').click(function (e) {
        if (e.target === this || $(this).hasClass('close')) {
            closeModal();
        }
    });
});

function renderGrid(data, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    container.innerHTML = '';
    data.forEach(item => {
        const card = document.createElement('div');
        card.className = 'project-card';
        card.onclick = () => openModal(item);
        
        const img = document.createElement('img');
        img.src = item.image;
        img.alt = item.title;
        
        const info = document.createElement('div');
        info.className = 'card-info';
        
        const title = document.createElement('h3');
        title.innerText = item.title;
        
        // Short description for the card (first sentence or ~100 chars)
        const shortDesc = document.createElement('p');
        shortDesc.innerText = item.description.split('.')[0] + '.';
        
        info.appendChild(title);
        info.appendChild(shortDesc);
        card.appendChild(img);
        card.appendChild(info);
        container.appendChild(card);
    });
}

function openModal(item) {
    const modal = $('.popup-container');
    const content = $('.popup-content');
    
    modal.find('h3').text(item.title);
    modal.find('p').text(item.description);
    
    const linkBtn = modal.find('.popup-urlhref');
    const linkImg = modal.find('.popup-url'); // The icon inside the link
    const mainImg = modal.find('.popup-img');
    
    mainImg.attr('src', item.image);
    mainImg.css('visibility', 'visible').css('opacity', '1');

    if (item.link) {
        linkBtn.attr('href', item.link).show();
    } else {
        linkBtn.hide();
    }

    modal.css("visibility", "visible").css("opacity", "1").css("transform", "scale(1)");
}

function closeModal() {
    const modal = $('.popup-container');
    modal.css("visibility", "hidden").css("opacity", "0").css("transform", "scale(1.1)");
}
