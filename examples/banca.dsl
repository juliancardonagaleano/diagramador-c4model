/*
 * Ejemplo de banca en línea (el clásico de c4model.com) escrito en el DSL de Structurizr.
 * Equivale a examples/banca.json; se importa con:
 *
 *   npx c4diagram import examples/banca.dsl --layout --out banca.json
 */
workspace "Banca en línea" "Ejemplo clásico del modelo C4: sistema de banca por internet." {

    model {
        cliente = person "Cliente personal" "Cliente del banco con cuentas personales."

        banca = softwareSystem "Sistema de banca en línea" "Permite a los clientes ver información de sus cuentas y hacer pagos." {
            webApp = container "Aplicación web" "Entrega el contenido estático y la aplicación de una sola página." "Java y Spring MVC" "Web Browser"
            spa = container "Aplicación de una sola página" "Provee toda la funcionalidad de banca a los clientes desde el navegador." "JavaScript y Angular"
            mobileApp = container "Aplicación móvil" "Provee un subconjunto de la funcionalidad de banca desde el móvil." "Xamarin" "Mobile App"
            api = container "Aplicación API" "Provee la funcionalidad de banca mediante una API JSON/HTTPS." "Java y Spring MVC" {
                signin = component "Controlador de inicio de sesión" "Permite a los usuarios iniciar sesión." "Spring MVC Rest Controller"
                accounts = component "Controlador de cuentas" "Provee información de las cuentas del cliente." "Spring MVC Rest Controller"
                security = component "Componente de seguridad" "Provee funcionalidad de autenticación y cambio de contraseña." "Spring Bean"
                mainframeFacade = component "Fachada del sistema central" "Fachada sobre el sistema bancario central." "Spring Bean"
            }
            db = container "Base de datos" "Almacena registro de usuarios, credenciales y logs de acceso." "Oracle Database" "Database"
        }

        mainframe = softwareSystem "Sistema bancario central" "Almacena toda la información bancaria de clientes, cuentas y transacciones." "Existing System"
        email = softwareSystem "Sistema de correo" "Sistema de correo electrónico de Microsoft Exchange." "Existing System"

        cliente -> banca "Consulta sus cuentas y hace pagos"
        banca -> mainframe "Obtiene información y hace pagos" "XML/HTTPS"
        banca -> email "Envía correos" "SMTP"
        email -> cliente "Envía correos a"
        cliente -> webApp "Visita bigbank.com" "HTTPS"
        cliente -> spa "Consulta sus cuentas y hace pagos"
        cliente -> mobileApp "Consulta sus cuentas y hace pagos"
        webApp -> spa "Entrega al navegador del cliente"
        spa -> api "Hace llamadas a la API" "JSON/HTTPS"
        mobileApp -> api "Hace llamadas a la API" "JSON/HTTPS"
        api -> db "Lee y escribe" "JDBC"
        api -> mainframe "Hace llamadas a la API" "XML/HTTPS"
        api -> email "Envía correos" "SMTP"
        spa -> signin "Hace llamadas a la API" "JSON/HTTPS"
        spa -> accounts "Hace llamadas a la API" "JSON/HTTPS"
        signin -> security "Usa"
        accounts -> mainframeFacade "Usa"
        security -> db "Lee y escribe" "JDBC"
        mainframeFacade -> mainframe "Hace llamadas a la API" "XML/HTTPS"
    }

    views {
        systemContext banca "contexto" {
            title "Contexto del sistema"
            include *
            autoLayout tb
        }

        container banca "contenedores" {
            title "Contenedores"
            include *
            autoLayout lr
        }

        component api "componentes-api" {
            title "Componentes de la API"
            include *
            include mobileApp
            autoLayout lr
        }

        styles {
            element "Person" {
                shape person
                background #08427b
                color #ffffff
            }
            element "Software System" {
                background #1168bd
                color #ffffff
            }
            element "Existing System" {
                background #999999
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
            }
            element "Component" {
                background #85bbf0
                color #000000
            }
            element "Database" {
                shape cylinder
            }
            element "Web Browser" {
                shape webbrowser
            }
            element "Mobile App" {
                shape mobiledeviceportrait
            }
        }
    }
}
