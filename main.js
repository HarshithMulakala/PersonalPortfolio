
$(document).ready(function () {
    $('#menu-icon').click(function () {
        $('#menu-icon').toggleClass('bx-x');
        $(".nav").toggleClass("open", 500);
    });
    $('.resumebutton').click(function () {
        $('.Resume').toggleClass('open');
    });
    $('.closeresume').click(function () {
        $('.Resume').toggleClass('open');
    });

    $('.projecttext').click(function () {
        if ($('.projecttext').text() == "Projects") {
            $('.projecttext').text("Work Experience")
            $('.WorkSlide').css("display", "flex");
            $('.ProjectsSlide').css("display", "none");
        }
        else {
            $('.projecttext').text("Projects");
            $('.ProjectsSlide').css("display", "flex");
            $('.WorkSlide').css("display", "none");
        }
    });

    $('.close').click(function () {
        $('.popup-container').css("visibility", "hidden");
        $('.popup-container').css("opacity", "0");
        $('.popup-container').css("transform", "scale(1.3)");
    });

    $('.swiper-slide').click(function (e) {
        $('.popup-urlhref').css("visibility", "visible");
        $('.popup-urlhref').css("opacity", "1");
        $('.popup-img').css("visibility", "hidden");
        $('.popup-img').css("opacity", "0");
        if ($(e.target).hasClass('BraveBear')) {
            $(".popup-container h3").text("Brave Bear");
            $(".popup-container p").text("Brave Bear is a unique app created using React Native for the frontend and Firebase for the backend. The app provides a safe space for teenagers to connect with professionals who specialize in mental health, offering free sessions to help them navigate through their struggles. With a user-friendly interface built through react-native alongside secure chat functionality and profile picture storage done through the integration of Google Firebase, Brave Bear empowers teens to seek support, fostering a community that promotes mental well-being and personal growth.");
            $(".popup-urlhref").attr("href", "https://expo.dev/@dimmer/BackOnTrack");
            $('.popup-img').css("visibility", "visible");
            $('.popup-img').css("opacity", "1");
            $(".popup-img").attr("src", "./BraveBear.png");
        }
        if ($(e.target).hasClass('BulletBounce')) {
            $(".popup-container h3").text("Bullet Bounce");
            $(".popup-container p").text("Bullet Bounce is an engaging 2D puzzle game created for DonkeyClick and submitted as part of a mini game jam. In this unique and challenging experience, the player takes control of a character and strategically fires a bullet, skillfully aiming to hit themselves. Behind the scenes, the entire backend code of the game was expertly crafted using the powerful C# programming language within the Unity game development engine. Through meticulous coding, the intricate mechanics and physics of bullet trajectory, collision detection, and player interactions were brought to life, resulting in a seamless and immersive gameplay experience.");
            $(".popup-urlhref").attr("href", "https://cert.itch.io/bullet-bounce");
            $(".popup-img").attr("src", "");
        }
        if ($(e.target).hasClass('Cashonomics')) {
            $(".popup-container h3").text("Cashonomics Website");
            $(".popup-container p").text("Cashonomics Website is a dynamic website I have specifically designed and coded for the nonprofit organization, aimed at promoting financial literacy and economic empowerment. Leveraging the power of SCSS, HTML, and JS, the website offers a visually appealing and user-friendly interface. The integration of Firebase as the backend infrastructure empowers administrators to create and manage engaging and informative blogs directly on the website. Through this seamless platform, admins can effortlessly share valuable insights, tips, and resources, fostering an interactive and educational community focused on improving financial well-being and understanding.");
            $(".popup-urlhref").attr("href", "https://cashonomics.me/");
            $(".popup-img").attr("src", "");
        }
        if ($(e.target).hasClass('QBot')) {
            $(".popup-container h3").text("Q Bot");
            $(".popup-container p").text("Q Bot is a powerful Discord bot developed using JavaScript and the Discord.js library. Its primary function is to enhance the music listening experience in voice channels by allowing users to play music from YouTube links. Leveraging the capabilities of Discord.js, the bot effortlessly handles commands to play, pause, and stop music, while also providing the flexibility to skip to the next song in the queue. The bot's queue feature ensures a smooth playback experience, allowing users to add multiple songs to the playlist and enjoy uninterrupted music. Moreover, Q Bot has been engineered to be versatile enough to serve multiple servers simultaneously, catering to the needs of numerous communities. Its seamless integration with Discord and reliable performance through the hosting of the bot by replit has garnered widespread adoption, attracting hundreds of users who enjoy its music playback functionality and other features.");
            $(".popup-urlhref").attr("href", "https://github.com/imcertain101/QuranBot/");
            $(".popup-img").attr("src", "");
        }
        if ($(e.target).hasClass('CashonomicsWork')) {
            $(".popup-container h3").text("Cashonomics Work");
            $(".popup-container p").text("Cashonomics is a student-led non-profit organization dedicated to promoting financial literacy across all age groups. As a Web Developer and Student Advisory Board Member, my role within the organization is multifaceted. I was responsible for the complete development of Cashonomics' website, including designing the user interface, implementing backend functionality, and crafting HTML/CSS elements. Beyond web development, I also serve as a valuable consultant, leveraging my expertise in technology and emphasizing the importance of establishing an online presence. Through my guidance and connections, I contribute to building relationships for the organization and educating its members about specific technological needs and the significance of utilizing technology to further the organizations mission of financial education.");
            $(".popup-urlhref").attr("href", "https://cashonomics.me/");
            $(".popup-img").attr("src", "");
        }
        if ($(e.target).hasClass('DonkeyClick')) {
            $(".popup-container h3").text("DonkeyClick");
            $(".popup-container p").text("DonkeyClick is an indie game company founded by me and two friends, specializing in the development and release of engaging mobile and PC games on various platforms, including the app store. As the main software developer and a founder, I assume a pivotal role in overseeing all projects, ensuring their successful execution along with coding a good majority of the functionality of each project. Currently we are only using Unity and C#, but look to expand into engines like Unreal Engine in the future. With exciting titles like Bullet Bounce and Bombkey Thief already under our belt, DonkeyClick has a promising future with a pipeline of upcoming projects.");
            $('.popup-urlhref').css("visibility", "hidden");
            $('.popup-urlhref').css("opacity", "0");
            $(".popup-img").attr("src", "");
        }
        if ($(e.target).hasClass('iTalentii')) {
            $(".popup-container h3").text("iTalentii Tech");
            $(".popup-container p").text("During my internship at iTalentii Tech, I served as a developer/assistant, helping the design and development of an app that provides access to the best deals and coupons on products. I took charge of the UI/UX design, employing tools like MidJourney and color palettes to create an appealing and user-friendly interface with using React/React-Native to bring this interface to life. Additionally, I developed some core functionality, implementing web scraping techniques to gather data from platforms like Amazon and Reddit, seamlessly integrating it into the app's categories. This experience enhanced my skills in UI/UX design, web scraping, data manipulation, and API integration, while also fostering qualities like responsibility and initiative. Overall, this internship deepened my understanding of computer science, equipping me with critical thinking, problem-solving, and adaptability—essential foundations for a successful career in the field.");
            $('.popup-urlhref').css("visibility", "hidden");
            $('.popup-urlhref').css("opacity", "0");
            $(".popup-img").attr("src", "");
        }
        $('.popup-container').css("visibility", "visible");
        $('.popup-container').css("opacity", "1");
        $('.popup-container').css("transform", "scale(1)");
    })

});